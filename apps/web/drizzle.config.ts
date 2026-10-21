import { defineConfig } from "drizzle-kit";

/**
 * D1 の migration を作るための設定 (`make db-generate`)。
 *
 * ⚠ schema は **feature ごと** に置く。ここは集めるだけで、機能の知識は持たない。
 * ⚠ 生成した SQL を適用するのは wrangler (`make db-migrate`)。drizzle-kit から
 *   D1 に直接つながない (ローカルは Miniflare、本番は Terraform が作った D1)。
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/features/*/db/schema.ts",
  out: "./migrations",
});
