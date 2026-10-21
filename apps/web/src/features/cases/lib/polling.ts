/**
 * 取り込みを追うときの間隔。**固定にしない。**
 *
 * ⚠ 読み取りは AI を通すので分単位かかることがある。3 秒固定のままだと、
 *   長い案件で数百回の往復になる。最初だけ細かく見て、あとは伸ばす。
 * ⚠ 上限で止める (諦めない)。ジョブは失敗しても `failed` になるので、終わりは必ず来る。
 */
export const LIST_POLL_MS = [3_000, 5_000, 8_000, 12_000, 20_000] as const;
export const JOB_POLL_MS = [2_000, 3_000, 5_000, 8_000, 15_000] as const;

/** 何回目の待ちか (0 始まり) から間隔を選ぶ。表の末尾で頭打ちにする。 */
export function backoffMs(step: number, table: readonly number[]): number {
  const index = Math.min(Math.max(step, 0), table.length - 1);
  return table[index]!;
}
