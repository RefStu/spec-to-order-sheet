import { defineConfig } from "vitest/config";

/**
 * apps/web の単体テスト。
 *
 * ⚠ **workerd プール (@cloudflare/vitest-pool-workers) は使えない。**
 *   0.22.0 の peer が vitest ^4.1.0 で、このリポジトリの vitest 5 と両立しない。
 *   Hono の API は `app.request(path, init, env)` に偽の Bindings を渡せば node でも試せる。
 *   実行環境そのもの (D1 / Queue / assets) の確認は `make dev-web` (Miniflare) で行う。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
