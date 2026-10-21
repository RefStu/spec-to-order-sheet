import { defineConfig } from "vitest/config";

// apps/ai の単体テスト。LLM や Turso は呼ばない (呼ぶ確認は mastra dev で行う)。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
