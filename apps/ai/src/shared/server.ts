import type { AiEnv } from "@repo/shared/env";

/**
 * ★ 読み取り 1 通ぶんの上限の**既定**。
 *
 * ⚠⚠ **Mastra の既定は 180 秒**で、内包 PDF の読み取り (分類 1 回 + 発注書 1 回 +
 *   依頼書の枚数ぶん) はそれを超える。超えると ai は **504 を返し、web は
 *   「読み取りに失敗」で終わる** — モデルは仕事を終えているのに結果が捨てられる。
 * ⚠ 明細が増えれば依頼書の枚数ぶん伸びる。**枠 (12 明細) を読み切れる長さ**にしてある。
 * ⚠⚠ **値の正は env の `AI_REQUEST_TIMEOUT_MS`** (ローカルは `apps/ai/.env.example`、
 *   デプロイ先は Terraform の `ai_request_timeout_ms`)。ここは env が
 *   渡ってこなかったときの保険で、**同じ値を 2 か所で管理しているのではない**
 *   (Terraform は Cloud Run の request timeout も同じ変数から導く)。
 */
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Mastra の HTTP サーバーの設定。
 * port は Cloud Run では PORT (8080) が自動で設定され、ローカルは `apps/ai/.env` の PORT。
 *
 * ⚠⚠ **Cloud Run 側の request timeout もこれ以上にすること。短いほうで切れる。**
 */
export function serverConfig(env: Pick<AiEnv, "PORT" | "AI_REQUEST_TIMEOUT_MS">) {
  return {
    port: env.PORT ?? 4111,
    // ⚠ コンテナ (Cloud Run / docker) の外から届くように全インターフェースで待つ。
    host: "0.0.0.0",
    timeout: env.AI_REQUEST_TIMEOUT_MS ?? DEFAULT_AI_REQUEST_TIMEOUT_MS,
  };
}
