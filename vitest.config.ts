import { defineConfig } from "vitest/config";

// ルートの vitest は tools/ と packages/ と infra/local/ を対象にする。
// apps/* は各アプリの vitest 設定で回す (どちらも node 環境)。
// ⚠ web を workerd プールで回したいところだが、@cloudflare/vitest-pool-workers の peer が
//   vitest ^4.1.0 で、このリポジトリの vitest 5 と両立しない。詳細は apps/web/vitest.config.ts。
export default defineConfig({
  test: {
    // ⚠ infra/local/* もここで回す。ルートの package.json の `test` は
    //    `pnpm -r --filter "./apps/*"` なので、各パッケージ側に test スクリプトを置いても届かない。
    include: [
      "tools/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "infra/local/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**"],
  },
});
