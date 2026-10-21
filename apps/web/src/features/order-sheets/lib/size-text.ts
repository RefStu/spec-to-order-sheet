/**
 * ★ ORDER SHEET の **Size 欄の書き方**。
 *
 * 出どころは**発注書のサイズ**（号数や長さ）。実物の ORDER SHEET では指輪の号数に
 * `#` が付いていた（発注書の印字は `10`、ORDER SHEET は `#10`）。
 *
 * ⚠⚠ **数字だけの印字のときにしか付けない。** 実物で確かめられたのは**指輪の号数 1 件だけ**で、
 *   ネックレスの `45cm` のような長さの表記に `#` を付けるのは明らかにおかしい。
 * ⚠ **既に `#` が付いている印字に二重に付けない。**
 * ⚠ **人が画面で直した値には通さない。** AI が転記するときだけの整形
 *   （`order-sheet-writer.ts` の経路は素通し）。
 * ⚠ **読み取りの記録は印字そのまま**（`purchase_order_lines.raw_size_text` /
 *   `ai_extraction_fields.quote`）。整えるのは ORDER SHEET の列だけ。
 */

/** 号数と見なす印字。**数字だけ**（小数は許す）。 */
const RING_SIZE = /^[0-9]+(?:\.[0-9]+)?$/u;

/** 号数の印。 */
export const RING_SIZE_PREFIX = "#";

/** 発注書のサイズを ORDER SHEET に載せる形にする。 */
export function formatSizeText(value: string | null): string | null {
  const text = value?.trim() ?? "";
  if (text.length === 0) return null;
  // ⚠ 数字だけの印字だけに付ける（`45cm` や `#10` はここで弾かれる）。
  return RING_SIZE.test(text) ? `${RING_SIZE_PREFIX}${text}` : text;
}
