/**
 * ★★ ORDER SHEET の**セルの文字の規則**。「画面に出ている文字が、そのまま xlsx に入る」の正。
 *
 * ⚠⚠ **xlsx を書くときに文字を変えない。** 以前は、描き出しのときにだけ
 *   変換が起きていた（画面と xlsx で文字が違った）:
 *   - QTY … `Number()` で数値にし、**数として読めない文字は消えていた**
 *   - SHIP DATE … `excelSerial()` でシリアル値にし、**`YYYY-MM-DD` で始まらない文字は消えていた**
 *     （画面の記入例 `2026/9/16` のとおりに打っても xlsx では空）。見え方も `2099/2/1 0:00:00` に変わっていた
 *   - DATE（`J12`）… 画面は `order_sheets.issued_on`、xlsx は出した日で、**値そのものが違った**
 *   いまは次の 3 つだけがこのファイルの仕事で、どれも画面と xlsx が**同じ関数（か、その写し）**を使う:
 *   ① ヘッダの印字の接頭辞（`SHIP : ` など）と値をつなぐ — 画面は接頭辞を入力欄の前に出す
 *   ② QTY を**数値のセルにしてよいか**の判定 — 文字は変えない（数値にしても同じ文字に見えるときだけ）
 *   ③ 日付を実例の書き方（`d/m/yy`）の文字にする — DATE（`J12`）の派生だけが使う
 * ⚠ 人が打った文字は整形しない（前後の空白を落とすのは保存のとき。`order-sheet-writer.ts`）。
 * ⚠ AI の値を実例の書き方にするのは**セルに入れるとき**（`order-sheet-generator.ts`。
 *   Code Master / Size / Description / 下部のメモの整形はそれぞれ `code-master.ts` /
 *   `size-text.ts` / `description-text.ts` / `normalizeNoteText()` にある）。
 *
 * ⚠⚠ **画面側に写しがある**（`cases/lib/order-sheet-form.ts` の `HEADER_PREFIXES` /
 *   `qtyNumberOf()`）。feature をまたいで import できないので、両側のテストが
 *   **同じリテラル**で突き合わせる。片方だけ直すと画面の合計と xlsx の `SUM` がずれる。
 */

/**
 * ① ヘッダの印字の接頭辞と値を 1 つの文字にする（実物も `SHIP : d/m/yy` の形で 1 セルに入っている）。
 *
 * ⚠ 値が空なら**接頭辞ごと空**（`SHIP : ` だけを残さない）。
 * ⚠ 値の中身は変えない（前後の空白だけ落とす。保存の時点で落ちているので実質そのまま）。
 */
export function headerCellText(prefix: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const body = String(value).trim();
  return body.length > 0 ? `${prefix}${body}` : null;
}

/**
 * QTY を数値のセルにしてよい文字の**最大の長さ**。
 *
 * ⚠ Excel の標準の表示形式（General）は 11 字を超える数を `1.23457E+11` のように丸めて見せる。
 *   そうなると画面の文字と違うので、長い数は文字のまま入れる（QTY でそこまで大きい数は来ない）。
 */
const MAX_NUMERIC_QTY_LENGTH = 11;

/**
 * ② QTY の文字を、**数値のセルにしてよいとき**だけ数にする。それ以外は `null`（= 文字のまま書く）。
 *
 * ⚠⚠ **「数として読める」＝「数値にしても同じ文字に見える」。** `Number()` が読める形
 *   （`3.0` / `03` / `1e3` / `0x10` / 全角の `３`）でも、数値にすると xlsx では `3` / `1000` / `16`
 *   と**別の文字に見える**ので、文字のまま入れる（その代わり `SUM` には入らない）。
 * ⚠⚠ **0 は 0**（`null` にしない）。読めなかった明細は数量 0 で作られる。
 * ⚠ 画面の合計（`cases/lib/order-sheet-draft.ts` の `qtyTotalOf()`）は写しの `qtyNumberOf()` で
 *   同じ判定をする。**Excel の `SUM` は数値のセルしか数えない**ので、これで画面と xlsx の合計が揃う。
 */
export function qtyNumberOf(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const body = String(text).trim();
  if (body.length === 0 || body.length > MAX_NUMERIC_QTY_LENGTH) return null;
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/u.test(body)) return null;
  const n = Number(body);
  return Number.isFinite(n) && String(n) === body ? n : null;
}

/**
 * ③ `YYYY-MM-DD` の日付を**実例の書き方**（`d/m/yy`。例: `J12` に `28/4/99`）にする。
 *   読めなければ `null`。
 *
 * ⚠ 使うのは DATE（`J12`）の派生だけ。**人が打った日付（SHIP / SHIP DATE / 工程表）には通さない**
 *   — 打った文字がそのまま出る。
 * ⚠ 日付としての正しさ（2 月 30 日など）は見ない。来るのは `toISOString()` の頭 10 文字だけ。
 */
export function sheetDateText(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso?.trim() ?? "");
  if (!m) return null;
  return `${Number(m[3])}/${Number(m[2])}/${m[1]!.slice(2)}`;
}

/**
 * ★ xlsx を**いま**出したら `J12` に入る日（`YYYY-MM-DD`、UTC）。
 *
 * ⚠⚠ **画面（`order-sheet-reader.ts`）と描き出し（`order-sheet-export.ts`）が同じこれを使う。**
 *   以前は画面は `order_sheets.issued_on`（発注日か、ORDER SHEET を作った日）を出し、
 *   xlsx は出した日を書いていたので、**同じ欄に別の日付**が出ていた。
 */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
