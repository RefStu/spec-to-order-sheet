import type { ExtractedField, PurchaseOrderExtraction, SpecSheetExtraction } from "../contract";

/**
 * 明細と依頼書を、**対応づけを聞くための短い表**にする。
 *
 * ⚠⚠ **`value` ではなく `quote` (原本の印字そのまま) を見せる。** `value` は正規化した後の
 *   値なので、それを見せると **ai と web が別々に正規化する**ことになる。
 *   正規化の規則の正は web (`order-sheets/lib/spec-no.ts`) の 1 か所だけ。
 * ⚠ 画像は渡さない。ここは紙を読み直すノードではなく、**読み取った文字だけを突き合わせる**。
 */

/** 印字そのまま。無ければ `-`。⚠ 改行は 1 行に潰す (表が崩れると読み違える)。 */
function printed(field: ExtractedField): string {
  const text = field.quote ?? (field.value === null ? null : String(field.value));
  const trimmed = text?.replace(/\s+/gu, " ").trim() ?? "";
  return trimmed.length > 0 ? trimmed : "-";
}

export function linkView(
  purchaseOrder: PurchaseOrderExtraction,
  specSheets: readonly SpecSheetExtraction[],
): string {
  const lines = purchaseOrder.lines.map(
    (line) =>
      `- lineNo ${line.lineNo} / 製造番号: ${printed(line.modelNo)} / 資材名: ${printed(line.productName)} / サイズ: ${printed(line.sizeText)}`,
  );
  const sheets = specSheets.map(
    (sheet, index) =>
      `- specSheetIndex ${index} / 仕様書No: ${printed(sheet.specNo)} / 品名: ${printed(sheet.productName)} / 品位: ${printed(sheet.purityText)}`,
  );

  return [
    "## 発注書の明細",
    lines.length > 0 ? lines.join("\n") : "- (1 行もありません)",
    "## 新製品依頼書",
    sheets.length > 0 ? sheets.join("\n") : "- (1 枚もありません)",
  ].join("\n\n");
}
