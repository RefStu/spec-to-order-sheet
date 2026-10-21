/**
 * `make gen` / `make gen-check`
 *
 * features/* を走査して登録ファイル (*.gen.ts) を生成する。
 *   --check  書き込まず、生成物が最新でなければ exit 1 (`make check` 用)
 *
 * ⚠ 内容が変わったときだけ書き込む。毎回書くと、dev 中に vite の監視が
 *   生成物の更新を拾って HMR が無限に回る。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GEN_TARGETS, scanFeatures } from "./gen-core.ts";

export interface GenResult {
  outFile: string;
  status: "unchanged" | "written" | "stale" | "skipped";
  features: string[];
}

export function runGen(root: string, opts: { check: boolean }): GenResult[] {
  return GEN_TARGETS.map((t) => {
    if (!existsSync(join(root, t.appDir))) {
      return { outFile: t.outFile, status: "skipped", features: [] };
    }
    const features = scanFeatures(join(root, t.featuresDir), t.entryFile);
    const next = t.render(features);
    const out = join(root, t.outFile);
    const current = existsSync(out) ? readFileSync(out, "utf8") : null;
    const names = features.map((f) => f.name);

    if (current === next) return { outFile: t.outFile, status: "unchanged", features: names };
    if (opts.check) return { outFile: t.outFile, status: "stale", features: names };

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, next);
    return { outFile: t.outFile, status: "written", features: names };
  });
}

function main() {
  const check = process.argv.includes("--check");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const results = runGen(root, { check });

  for (const r of results) {
    const list = r.status === "skipped" ? "(アプリが未作成)" : `[${r.features.join(", ")}]`;
    console.error(`[gen] ${r.status.padEnd(9)} ${r.outFile} ${list}`);
  }
  if (results.some((r) => r.status === "stale")) {
    console.error("[gen][ERROR] 登録ファイルが最新ではありません。`make gen` を実行してください。");
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
