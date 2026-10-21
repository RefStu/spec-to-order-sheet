/**
 * ★★ **依頼書を何枚まで同時に読むか**と、上限つきで並べて走らせる道具。
 *
 * ⚠⚠ **同じ関数が 2 か所に要る** (`steps/extract.ts` と `steps/locate-pictures.ts`)。
 *   上限を 2 か所で持つと、片方だけ上げたときに Cloud Run の CPU を食い合う。
 */

/**
 * 同時に走らせる依頼書の枚数の上限。
 *
 * ⚠ Cloud Run の 1 インスタンスの CPU を食い合わせないための上限。
 *   ここを上げるなら Cloud Run に割り当てる cpu も一緒に見ること。
 */
export const SPEC_SHEET_CONCURRENCY = 3;

/** 上限つきで並べて走らせ、**入力と同じ並び**で結果を返す。 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      // ⚠ 添字で埋める。push にすると**終わった順**に並び、依頼書と写真の対応が壊れる。
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
