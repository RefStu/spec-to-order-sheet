/**
 * ★ 観測のトレース ID を作る。
 *
 * ⚠⚠ **なぜ web が作るのか。**
 *   処理はキューを挟んだ非同期で、「1 HTTP リクエスト = 1 トレース」は成り立たない
 *   (アップロードの応答は 202 で、読み取りはそのあと別プロセスで走る)。
 *   しかも **Mastra は `traceparent` ヘッダを自分では拾わない**
 *   (`@mastra/core` 1.67 / `@mastra/langfuse` 1.5.7 を読んで確認した)。
 *   受け取れるのは `TracingOptions.traceId` を**明示的に渡したとき**だけ。
 *   → **ジョブを積むときに web が ID を作り、`ai_jobs.trace_id` に残して ai へ渡す。**
 *
 * ⚠ 形は **W3C の trace id と同じ 32 桁の 16 進**にしてある。
 *   将来 Worker 側に OTel を入れたとき、そのまま親として繋げられる。
 * ⚠ **1 アップロード (= 1 ジョブ) が 1 トレース。** 案件はトレースをまたぐので、
 *   Langfuse の session (`metadata.sessionId`) で束ねる。
 */
export function newTraceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
