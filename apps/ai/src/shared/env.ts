import { type AiEnv, aiEnvSchema, loadEnv } from "@repo/shared/env";

let cached: AiEnv | undefined;

/**
 * process.env を検証して返す (初回だけ検証し、以降は同じ値を返す)。
 *
 * ⚠ import した時点では評価しない。テストや型検査で env が無くても落ちないように、
 *   値が必要になった所 (mastra/index.ts の起動時など) で呼ぶ。
 */
export function getAiEnv(): AiEnv {
  cached ??= loadEnv(aiEnvSchema, process.env);
  return cached;
}

/** テスト用: キャッシュを捨てる。 */
export function resetAiEnvForTest(): void {
  cached = undefined;
}
