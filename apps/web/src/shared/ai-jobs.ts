/**
 * ★ ジョブが「取り残された」と見なすまでの時間。
 *
 * ⚠⚠ **進行中のまま誰も畳まない行が実在する。** `runJob()` は最初に `markJobRunning()` を
 *   呼び、失敗したら `markJobFailed()` を呼ぶが、**プロセスが落ちると誰も failed に落とさない**。
 *   - ローカル: 読み取りは数分かかる。その間に vite が Worker を作り直す / `make dev` を
 *     入れ直すと、走っている consumer ごと消えて `running` の行だけが残る。
 *   - `enqueueJob()` は D1 に `queued` で書いてからキューへ送る (順番はこれで正しい)。
 *     Miniflare はキューの中身を持ち越さないので、配る前に落ちると行だけが残る。
 *   取り残された行が 1 つでもあると `progressOf()` はその案件を**永遠に「読み取り中」**と
 *   言い続ける (進行中を失敗より優先するのは正しい。`cases/lib/progress.ts` を参照)。
 *
 * ⚠⚠ **`apps/ai` の `AI_REQUEST_TIMEOUT_MS` (15 分) より必ず長くすること。**
 *   短くすると、**正常に走っている読み取りを途中で「失敗」と呼び始める。**
 *
 * ⚠ ここに置いた理由: 読む側が 3 つの feature にまたがり (cases の進み具合 /
 *   order-sheets の空の枠 / purchase-orders のやり直し)、中身は業務の規則ではなく
 *   **キューの時間**の話だから (同じ理由で `shared/queue.ts` が queue 名を知っている)。
 *   **値を 2 か所に書かない。** 写すとローカルだけが静かにずれる。
 */
export const JOB_STALE_MS = 30 * 60 * 1000;

/**
 * 「これより古い進行中は取り残し」という時刻 (epoch ミリ秒)。
 * ⚠ `ai_jobs.queued_at` / `started_at` は `timestamp_ms` の integer 列なので、そのまま比べられる。
 */
export function staleBefore(now: number = Date.now()): number {
  return now - JOB_STALE_MS;
}
