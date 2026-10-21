import type { ExtractedField } from "@repo/ai/contracts/doc-extract";

/**
 * 読み取った欄を DB の型に落とす。
 *
 * ⚠ 正規化は原則 AI 側 (`value` が正規化後) だが、**モデルの出力は信用しない**。
 *   数量に文字列が来ることも、日付が YYYY/MM/DD のままのこともある。
 */

/** 数量など。数値にならなければ null。 */
export function asInteger(field: ExtractedField): number | null {
  if (typeof field.value === "number") {
    return Number.isFinite(field.value) ? Math.trunc(field.value) : null;
  }
  if (typeof field.value !== "string") return null;
  // 全角数字とカンマ区切りを許す。
  const normalized = field.value
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[,\s]/g, "");
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** そのままの文字列。空文字は null にする。 */
export function asText(field: ExtractedField): string | null {
  if (field.value === null) return null;
  const text = String(field.value).trim();
  return text.length > 0 ? text : null;
}

/**
 * 日付。`YYYY-MM-DD` にできなければ null。
 * ⚠ **日付の取り違えは誤りの種類 `date` として数える**ので、直せないものは黙って入れない。
 */
export function asDate(field: ExtractedField): string | null {
  const text = asText(field);
  if (text === null) return null;

  const match = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/.exec(text);
  if (!match) return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;

  const [, year, month, day] = match;
  const monthNo = Number(month);
  const dayNo = Number(day);
  if (monthNo < 1 || monthNo > 12 || dayNo < 1 || dayNo > 31) return null;
  return `${year}-${String(monthNo).padStart(2, "0")}-${String(dayNo).padStart(2, "0")}`;
}
