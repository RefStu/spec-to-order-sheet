// @ts-check
/**
 * ESLint の共通設定 (flat config)。
 *
 * - baseConfig():        typescript-eslint の推奨設定
 * - boundariesConfig():  feature / shared の境界ルール
 *
 * ⚠ eslint-plugin-boundaries v7 の element は常に「フォルダ単位」。
 *   feature の中の層 (UI / Worker 専用) は、element の中の相対パス
 *   (fileInternalPath) で区別する。
 */
import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";

/** web の feature の中で、ブラウザで動くファイル。 */
const WEB_UI_PATHS = ["components/**", "hooks/**", "pages/**", "lib/**", "schema.ts", "client.ts"];
/** web の feature の中で、Worker でだけ動くファイル。 */
const WEB_SERVER_PATHS = ["api/**", "services/**", "db/**", "queues/**", "server.ts"];
/** web の shared の中で、Worker でだけ動くファイル。 */
const WEB_SHARED_SERVER_PATHS = ["hono.ts", "db.ts", "queue.ts", "ai/**"];
/** 自動生成された登録ファイル (features を import してよい唯一の場所)。 */
const GEN_PATHS = ["*.gen.ts", "*.gen.tsx"];
/**
 * 取り込み〜 ORDER SHEET の 1 本のパイプライン。この 5 つだけは相互に import してよい。
 *
 * ⚠ 例外にしてある理由。読み取りは「キューに積む → Cloud Run を呼ぶ → 発注書 / 依頼書 /
 *   ORDER SHEET / 欄単位の記録に書く」で、**必ず複数の feature にまたがって書く**。
 *   一方、境界ルールの目的は feature をディレクトリごと消せるようにすること。
 *   この 5 つは切り離して消すことの無い 1 本の流れなので、ここを閉じても守るものが無い。**この 5 つの外側との境界は閉じたまま**にしてある。
 */
const INTAKE_FEATURES = [
  "files",
  "purchase-orders",
  "revisions",
  "order-sheets",
  "ai-review",
  // ⚠ partners は取引先マスタ。この流れからは参照専用だが、
  //   `purchase_orders.partner_id` と `order_sheets.partner_id` が NOT NULL なので、
  //   発注書から読んだ取引先をここで引く必要がある。
  "partners",
];
const INTAKE_GLOB = `{${INTAKE_FEATURES.join(",")}}`;

export function baseConfig() {
  return tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  });
}

/**
 * apps/web 専用のルール。
 *
 * ⚠ Workers ランタイムにもブラウザにも node の標準モジュールは無い
 *   (nodejs_compat を付けても一部だけ)。設定ファイル (vite.config.ts など) は
 *   src/ の外にあるので、ここでは src/ 以下だけを対象にする。
 */
export function webRuntimeConfig() {
  return [
    {
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["node:*"],
                message:
                  "Workers ランタイム / ブラウザに node の標準モジュールはありません。WebCrypto (crypto.subtle) などの Web 標準 API を使ってください。",
              },
            ],
          },
        ],
      },
    },
  ];
}

export function boundariesConfig() {
  return [
    {
      files: ["**/*.{ts,tsx,js,mjs}"],
      plugins: { boundaries },
      settings: {
        "import/resolver": {
          typescript: {
            alwaysTryTypes: true,
            noWarnOnMultipleProjects: true,
            project: [
              "tsconfig.json",
              "apps/*/tsconfig.json",
              "packages/*/tsconfig.json",
              "infra/local/*/tsconfig.json",
            ],
          },
        },
        // ⚠ 上から順に評価され、最初に一致したものが使われる。具体的なものを先に書く。
        "boundaries/elements": [
          { type: "web-feature", pattern: "apps/web/src/features/*", capture: ["feature"] },
          { type: "web-shared", pattern: "apps/web/src/shared" },
          { type: "web-app", pattern: "apps/web/src/app" },
          { type: "ai-feature", pattern: "apps/ai/src/features/*", capture: ["feature"] },
          { type: "ai-shared", pattern: "apps/ai/src/shared" },
          { type: "ai-mastra", pattern: "apps/ai/src/mastra" },
          { type: "pkg-shared", pattern: "packages/shared" },
        ],
      },
      rules: {
        "boundaries/dependencies": [
          "error",
          {
            // 外部ライブラリや未分類のファイルは許可し、禁止したい関係だけを書く。
            default: "allow",
            // ⚠ 既定では同じ element (= 同じ feature) の中の依存を検査しない。
            //   feature の中の UI → api/ を禁止するために必要。
            checkInternals: true,
            policies: [
              // --- ① feature は他の feature を import しない ---------------------------
              {
                from: { element: { types: ["web-feature", "ai-feature"] } },
                disallow: {
                  to: {
                    element: {
                      type: "{{ from.element.types.[0] }}",
                      captured: { feature: "!{{ from.element.captured.feature }}" },
                    },
                  },
                },
                message:
                  "feature '{{ from.element.captured.feature }}' から別の feature '{{ to.element.captured.feature }}' は import できません。共通化するなら shared へ、データが要るなら相手の API を使ってください。",
              },

              // --- ①-例外 取り込みパイプラインの 5 feature は相互に import してよい ------
              // ⚠ 順序が意味を持つ。boundaries は last-write-wins なので、① の **後ろ** に
              //   置かないと効かない。逆に ③ (UI → Worker 専用) はこれより後ろに置く。
              {
                from: { element: { type: "web-feature", captured: { feature: INTAKE_GLOB } } },
                allow: {
                  to: { element: { type: "web-feature", captured: { feature: INTAKE_GLOB } } },
                },
              },

              // --- ② shared / packages は features を知らない -----------------------
              {
                from: { element: { types: ["web-shared", "ai-shared", "pkg-shared"] } },
                disallow: {
                  to: { element: { types: ["web-feature", "ai-feature", "web-app", "ai-mastra"] } },
                },
                message:
                  "shared ({{ from.element.types.[0] }}) は機能の知識を持てません。features / app を import しないでください。",
              },
              {
                from: { element: { type: "pkg-shared" } },
                disallow: { to: { element: { types: ["web-shared", "ai-shared"] } } },
                message: "@repo/shared はアプリのコードを import できません。",
              },

              // --- ③ ブラウザで動くファイルは Worker 専用のコードを値で import しない -------
              // ⚠ 相手の feature を問わない。①-例外で取り込みパイプラインの 5 つは相互に
              //   import できるようにしたので、ここを「同じ feature の中だけ」にしておくと
              //   **UI から別の feature の db / services が値で読めてしまう**。
              {
                from: { element: { type: "web-feature", fileInternalPath: WEB_UI_PATHS } },
                dependency: { kind: "value" },
                disallow: {
                  to: {
                    element: {
                      type: "web-feature",
                      fileInternalPath: WEB_SERVER_PATHS,
                    },
                  },
                },
                message:
                  "UI から Worker 専用のコードは import できません。型だけなら `import type` を使ってください。",
              },
              {
                from: { element: { type: "web-feature", fileInternalPath: WEB_UI_PATHS } },
                dependency: { kind: "value" },
                disallow: {
                  to: {
                    element: { type: "web-shared", fileInternalPath: WEB_SHARED_SERVER_PATHS },
                  },
                },
                message:
                  "UI から shared の Worker 専用モジュール (hono / db / ai) は import できません。",
              },
              {
                from: {
                  element: { type: "web-shared", fileInternalPath: ["ui/**", "api-client.ts"] },
                },
                dependency: { kind: "value" },
                disallow: {
                  to: {
                    element: { type: "web-shared", fileInternalPath: WEB_SHARED_SERVER_PATHS },
                  },
                },
                message:
                  "shared/ui と shared/api-client から Worker 専用モジュールは import できません。",
              },

              // --- ④ web → ai は contract.ts の型だけ ------------------------------------
              {
                from: { element: { types: ["web-feature", "web-shared", "web-app"] } },
                disallow: { to: { element: { types: ["ai-feature", "ai-shared", "ai-mastra"] } } },
                message:
                  "web から ai のコードは import できません。`import type` で contract.ts の型だけを使ってください。",
              },
              {
                from: { element: { types: ["web-feature", "web-shared", "web-app"] } },
                dependency: { kind: "type" },
                allow: { to: { element: { type: "ai-feature", fileInternalPath: "contract.ts" } } },
              },
              {
                from: { element: { types: ["ai-feature", "ai-shared", "ai-mastra"] } },
                disallow: { to: { element: { types: ["web-feature", "web-shared", "web-app"] } } },
                message: "ai から web のコードは import できません。",
              },

              // --- ⑤ app / mastra は登録ファイル経由でだけ features を読む --------------
              {
                from: {
                  element: {
                    types: ["web-app", "ai-mastra"],
                    fileInternalPath: [`!{${GEN_PATHS.join(",")}}`],
                  },
                },
                disallow: { to: { element: { types: ["web-feature", "ai-feature"] } } },
                message:
                  "entry から features を直接 import しないでください。登録は自動生成 (make gen) に任せます。",
              },
              {
                from: {
                  element: { types: ["web-feature", "web-shared", "ai-feature", "ai-shared"] },
                },
                disallow: { to: { element: { types: ["web-app", "ai-mastra"] } } },
                message: "features / shared から entry (app / mastra) は import できません。",
              },
              // 例外: hc<AppType> を作るために、api-client だけが生成物の型を読む。
              // ⚠ 値の import は上の disallow のまま (entry のコードを持ち込まない)。
              {
                from: { element: { type: "web-shared", fileInternalPath: ["api-client.ts"] } },
                dependency: { kind: "type" },
                allow: {
                  to: {
                    element: { type: "web-app", fileInternalPath: [`{${GEN_PATHS.join(",")}}`] },
                  },
                },
              },
              // 例外: service binding (RPC) の型を書くために、hono.ts だけが
              // feature の entrypoint.ts を **型として** 読む。
              // ⚠ **値の import は上の disallow のまま。** shared が feature の実装を
              //   抱え込むと、feature をディレクトリごと消せなくなる (境界の目的そのもの)。
              // ⚠ 読んでよいのは `entrypoint.ts` **だけ**。api / services / db は対象外。
              //   entrypoint.ts は「Worker 間で呼べる面」だけを書く薄い層という約束にしてある。
              {
                from: { element: { type: "web-shared", fileInternalPath: ["hono.ts"] } },
                dependency: { kind: "type" },
                allow: {
                  to: { element: { type: "web-feature", fileInternalPath: ["entrypoint.ts"] } },
                },
              },
            ],
          },
        ],
      },
    },
  ];
}
