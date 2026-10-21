/**
 * ★★ **ノード 1 回ぶんの記録**と、その足し合わせ方。
 *
 * ⚠⚠ **同じ関数が 2 か所にあった** (`steps/extract.ts` と `steps/link.ts`)。3 か所目
 *   (`steps/locate-pictures.ts`) ができる前にここへ出した。**足し方の正はここだけ。**
 * ⚠ 費用と時間の扱いは**別物**。トークンは**全ノードの合計**でよい (費用は足し算で増える) が、
 *   `latencyMs` は**実時間**にする。ノードの latency を足すと、並列に読んでいるぶんだけ
 *   実際にかかった時間を超える (「250 秒で終わったのに 400 秒」と記録される)。
 *   そのため**この file は latencyMs を足す関数を持たない** (各 step が壁時計で測る)。
 */

/** 1 回の読み取りぶんの記録 (`ai_jobs` の費用・時間・モデルに使う)。 */
export interface NodeRun {
  /** 実際に使われたモデル。プロバイダが返さないことがあるので null を許す。 */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  rawOutput: string;
}

/** ⚠ **両方 null のときだけ null。** 片方でも数があれば数にする (0 と「分からない」を分ける)。 */
export function addTokens(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * 生出力の配列に n 本足す。
 *
 * ⚠ `steps/extract.ts` が `JSON.stringify(string[])` で作っているので、同じ形のまま**末尾に**足す。
 * ⚠⚠ **1 本目が分類ノードの生出力であることを壊さない。** 分類が外したとき
 *   (「依頼書 0 枚」と答えたときなど) に人が気づける場所は、ここと Langfuse のトレースだけ。
 * ⚠ 読めない形だったら**捨てずに**丸ごと 1 本目として扱う (記録を失わない)。
 */
export function appendRawOutputs(current: string, added: readonly string[]): string {
  let list: string[];
  try {
    const parsed: unknown = JSON.parse(current);
    list = Array.isArray(parsed) ? (parsed as string[]) : [current];
  } catch {
    list = [current];
  }
  return JSON.stringify([...list, ...added]);
}
