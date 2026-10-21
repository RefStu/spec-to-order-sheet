/**
 * feature の自動登録 — 純粋な部品。
 *
 * features/<name>/{server.ts,client.ts,feature.ts} を走査して登録ファイル (*.gen.ts) の中身を作る。
 * CLI (gen.ts) と、apps/web の vite プラグインの両方から使う。
 *
 * ⚠ 登録ファイルを手で編集させない理由: feature を足すたびに共通ファイルを書き換えると、
 *   並行して開発しているブランチ同士でそのファイルが衝突する。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Feature {
  /** ディレクトリ名 (kebab-case)。API のパス (/api/<name>) にも使う。 */
  name: string;
  /** import の識別子に使う camelCase 名。 */
  id: string;
}

/** feature 名として許すのは kebab-case だけ (先頭は英小文字)。 */
export const FEATURE_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function toCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function toPascal(name: string): string {
  const camel = toCamel(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * `featuresDir/<name>/<entryFile>` が存在する feature を名前順に返す。
 * featuresDir が無ければ空配列 (apps がまだ無い段階でも動くように)。
 * 名前が kebab-case でないディレクトリは無視せずエラーにする (識別子が作れないため)。
 */
export function scanFeatures(featuresDir: string, entryFile: string): Feature[] {
  if (!existsSync(featuresDir)) return [];
  return readdirSync(featuresDir)
    .filter((name) => !name.startsWith(".") && statSync(join(featuresDir, name)).isDirectory())
    .filter((name) => existsSync(join(featuresDir, name, entryFile)))
    .sort()
    .map((name) => {
      if (!FEATURE_NAME_RE.test(name)) {
        throw new Error(`feature 名は kebab-case にしてください: ${join(featuresDir, name)}`);
      }
      return { name, id: toCamel(name) };
    });
}

const HEADER = [
  "// ⚠ 自動生成ファイル — 編集禁止 (tools/gen/gen.ts が生成する)。",
  "// feature の追加・削除は features/<name>/ を足す・消してから `make gen` で行う。",
].join("\n");

/**
 * apps/web/src/app/routes.gen.ts
 *
 * ⚠ **アプリはここで組み立てる。** `createApp()` に `.route()` を静的に連結した
 *   **具体的な値** を export し、その `typeof` を AppType にする。
 *   `mountRoutes<A extends Hono<any, any, any>>(app: A)` のような総称の関数にすると、
 *   `.route()` が返す Schema が `& any` になって **hc の RPC 型が丸ごと消える**
 *   (エラーは出ないので気付けない)。確認は apps/web/src/app/rpc-type.test.ts。
 */
export function renderWebRoutes(features: Feature[]): string {
  const imports = features.map(
    (f) => `import { api as ${f.id}Api } from "../features/${f.name}/server";`,
  );
  const chain = features.map((f) => `\n  .route("/api/${f.name}", ${f.id}Api)`).join("");
  return [
    HEADER,
    'import { createApp } from "../shared/hono";',
    ...imports,
    "",
    "/** feature の API をすべて連結した Hono アプリ。worker.ts の fetch はこれを使う。 */",
    `export const featureApi = createApp()${chain};`,
    "",
    "/** hc<AppType> に渡す型。feature 分の RPC 型がすべて入っている。 */",
    "export type AppType = typeof featureApi;",
    "",
    `export const featureNames = ${JSON.stringify(features.map((f) => f.name))} as const;`,
    "",
  ].join("\n");
}

/**
 * apps/web/src/app/queues.gen.ts
 *
 * features/<name>/queues/consumer.ts が `consumer` を export していれば集める。
 * Worker の queue ハンドラは 1 つしか持てないので、worker.ts が queue 名で振り分ける。
 */
export function renderWebQueues(features: Feature[]): string {
  const imports = features.map(
    (f) => `import { consumer as ${f.id}Consumer } from "../features/${f.name}/queues/consumer";`,
  );
  const list = features.map((f) => `${f.id}Consumer`).join(", ");
  return [HEADER, ...imports, "", `export const queueConsumers = [${list}] as const;`, ""].join(
    "\n",
  );
}

/** apps/web/src/app/router.gen.tsx */
export function renderWebRouter(features: Feature[]): string {
  const imports = features.map(
    (f) => `import { routes as ${f.id}Routes } from "../features/${f.name}/client";`,
  );
  const spread = features.map((f) => `...${f.id}Routes`).join(", ");
  return [HEADER, ...imports, "", `export const featureRoutes = [${spread}] as const;`, ""].join(
    "\n",
  );
}

/**
 * apps/web/src/app/entrypoints.gen.ts
 *
 * ⚠⚠ **service binding (RPC) の口。** `WorkerEntrypoint` は **Worker の entry から
 *   named export されていないと束ねられない**ので、ここで集めて worker.ts が再 export する。
 * ⚠ **手で worker.ts に書き足さないこと。** feature を足すたびに共通ファイルを編集すると、
 *   並行して開発しているブランチ同士で衝突する (それを避けるためにこの仕組みがある)。
 * ⚠ クラス名は `<Pascal>Entrypoint`。`features/<name>/entrypoint.ts` がそれを export する。
 */
export function renderWebEntrypoints(features: Feature[]): string {
  const lines = features.map(
    (f) => `export { ${toPascal(f.name)}Entrypoint } from "../features/${f.name}/entrypoint";`,
  );
  return [
    HEADER,
    "",
    "// ⚠ wrangler.jsonc の services[].entrypoint と**同じクラス名**にすること",
    "//   (ずれると起動時に「no such named entrypoint」で落ちる)。",
    ...lines,
    "",
  ].join("\n");
}

/** apps/ai/src/mastra/registry.gen.ts */
export function renderAiRegistry(features: Feature[]): string {
  const imports = features.map(
    (f) => `import { feature as ${f.id}Feature } from "../features/${f.name}/feature";`,
  );
  const list = features.map((f) => `${f.id}Feature`).join(", ");
  return [HEADER, ...imports, "", `export const features = [${list}] as const;`, ""].join("\n");
}

export interface GenTarget {
  /** リポジトリ root からの相対パス。 */
  outFile: string;
  /** 対象アプリの root。無ければこのターゲットは生成しない。 */
  appDir: string;
  featuresDir: string;
  entryFile: string;
  render: (features: Feature[]) => string;
}

export const GEN_TARGETS: readonly GenTarget[] = [
  {
    outFile: "apps/web/src/app/routes.gen.ts",
    appDir: "apps/web",
    featuresDir: "apps/web/src/features",
    entryFile: "server.ts",
    render: renderWebRoutes,
  },
  {
    outFile: "apps/web/src/app/queues.gen.ts",
    appDir: "apps/web",
    featuresDir: "apps/web/src/features",
    entryFile: "queues/consumer.ts",
    render: renderWebQueues,
  },
  {
    outFile: "apps/web/src/app/router.gen.tsx",
    appDir: "apps/web",
    featuresDir: "apps/web/src/features",
    entryFile: "client.ts",
    render: renderWebRouter,
  },
  {
    outFile: "apps/web/src/app/entrypoints.gen.ts",
    appDir: "apps/web",
    featuresDir: "apps/web/src/features",
    entryFile: "entrypoint.ts",
    render: renderWebEntrypoints,
  },
  {
    outFile: "apps/ai/src/mastra/registry.gen.ts",
    appDir: "apps/ai",
    featuresDir: "apps/ai/src/features",
    entryFile: "feature.ts",
    render: renderAiRegistry,
  },
];
