import type { ExtractedField } from "@repo/ai/contracts/doc-extract";

/**
 * **欄 1 つ = 1 行** の記録。`ai_extraction_fields` にそのまま入る形。
 *
 * ⚠⚠ **これが無いと 3 つとも成り立たない**:
 *   1. 合格条件の正答率
 *   2. 画面で AI の欄と人の欄を塗り分ける
 *   3. AI の欄から「原本のどこから来たか」を辿る
 * ⚠ **新しい列は足さない。** 既にある汎用の器をそのまま使う。
 * ⚠ `targetRowId` は **本体を INSERT する前に決めた UUIDv7**。だから ID を先に採番する。
 */
export interface FieldRecord {
  targetTable: string;
  targetRowId: string;
  targetColumn: string;
  /** 帳票から読んだ文字列 (= AI の `quote`。原本の印字そのまま)。 */
  rawValue: string | null;
  /** 正規化・型変換した後の値 (= AI の `value`)。 */
  normalizedValue: string | null;
  /** 0..100。`ai_extraction_fields.confidence` は NOT NULL。 */
  confidence: number;
  pageNo: number | null;
}

/**
 * 確信度がこれ未満なら人に見てもらう。
 * ⚠ 画面の閾値 (order-sheets/services/order-sheet-reader.ts の `CONFIDENCE_THRESHOLD`) は 0..1、こちらは 0..100。
 *   ★ 実測で決め直す。いずれは `partners.auto_apply_threshold` で取引先ごとに変える。
 */
export const LOW_CONFIDENCE_100 = 70;

/** 読み取った 1 欄を、記録の行に直す。値が無い欄は記録しない (呼び出し側で捨てる)。 */
export function toFieldRecord(
  field: ExtractedField,
  target: { table: string; rowId: string; column: string },
): FieldRecord | null {
  // ⚠ 印字が無かった欄は **行を作らない**。作ると「AI が埋めた欄」に数えられてしまい、
  //   正答率の分母が水増しされる (数えるのは AI が埋めた欄だけ)。
  if (field.value === null) return null;

  return {
    targetTable: target.table,
    targetRowId: target.rowId,
    targetColumn: target.column,
    rawValue: field.quote,
    normalizedValue: String(field.value),
    confidence: field.confidence,
    pageNo: field.page,
  };
}

/** 読み取った欄が「原本に無かったのに埋められた」= でっち上げの疑いか。 */
export function looksFabricated(field: ExtractedField, pageText: string | null): boolean {
  // 値はあるのに、原本の印字 (quote) が無い。
  if (field.value !== null && (field.quote === null || field.quote.trim() === "")) return true;
  // quote があるのに、そのページの文字に見当たらない。
  if (field.quote && pageText && !pageText.includes(field.quote.trim())) return true;
  return false;
}
