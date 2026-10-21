/**
 * ★ ORDER SHEET の **Code master の整形**。
 *
 * ⚠⚠ **以前は「画面では 1 つの textarea、DB では 2 つの列」だった。**
 *   いまは枠のセルがそのまま欄なので、1 段目は `"D16"`、原型No は `"D17"` という
 *   **別々のセル**（⚠ 2 件目なら `"D22"` / `"D23"`。絶対番地へ変えた）。
 *   `joinCodeMaster` / `splitCodeMaster` は要らなくなったので消した。
 * ⚠ **1 段目だけが突き合わせの鍵**（発注書の製造番号 = 依頼書の仕様書No）。
 *   2 段目を混ぜると鍵が汚れ、明細と依頼書が結べなくなる。
 */
/**
 * ★ 1 行目 (製造番号) を **ORDER SHEET に載せる形**に整える。
 *
 * 実物は `YYYY-MM-Sxxx` の形だが、依頼書の仕様書No は**升目に区切られて印字**されているため、
 * 読み取りが `2099 - 12 - S002` のように空白を挟んで返すことがある。
 *
 * ⚠⚠ **`spec-no.ts` の `normalizeSpecNo()` を使い回さないこと。** あれは**比べるためだけ**の
 *   正規化で `-` ごと落とす (`20991 2S002` のような形になる)。突き合わせの鍵は今までどおり
 *   `normalizeSpecNo()`、**画面と xlsx に出す文字はこちら**、と役割を分ける。
 * ⚠⚠ **読み取りの記録には使わない。** `revision_requests.spec_no` /
 *   `purchase_order_lines.raw_model_no` / `ai_extraction_fields.quote` は**印字そのまま**。
 *   整えてよいのは ORDER SHEET の列 (`order_sheet_lines.customer_item_code_text`) だけ。
 * ⚠⚠ **桁を足さない・年を補わない。** 発注書の 2 桁年 (`99-05-S001`) をそのまま残すのは、
 *   4 桁に伸ばすと**世紀を当てずっぽうで決める**ことになるため (突き合わせは
 *   `specNoKeys()` が 2 桁と 4 桁の両方を作って面倒をみている)。
 * ⚠ **人が画面で直した値には通さない。** AI が転記するときだけの整形。
 */
export function formatCodeMasterText(value: string | null): string | null {
  const raw = value?.trim() ?? "";
  if (raw.length === 0) return null;

  // ① 全角のハイフン類と全角空白を半角に寄せる (升目の印字は全角のことがある)。
  //   ⚠ 長音符 (`ー`) は入れない。仮名の一部を区切りに変えてしまう。
  const half = raw.replace(/[－―‐−]/gu, "-").replace(/\u3000/gu, " ");
  // ② 区切りの前後の空白だけを詰める。
  const joined = half
    .replace(/\s+/gu, " ")
    .replace(/\s*-\s*/gu, "-")
    .trim();
  // ③ ⚠ **区切りが 1 つも無く、空白だけで割れているときに限り** 空白を区切りに替える
  //   (`2099 12 S002`)。`-` が 1 つでもあれば、空白は既に②で詰みきっている。
  return joined.includes("-") ? joined : joined.replace(/ /gu, "-");
}
