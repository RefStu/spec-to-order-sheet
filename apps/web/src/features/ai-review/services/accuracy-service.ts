import { and, eq, inArray } from "drizzle-orm";
import {
  ORDER_SHEET_FIELDS,
  aiFieldTargets,
  fieldKeyOfTarget,
  isAiField,
  type OrderSheetFieldKey,
} from "../../order-sheets/lib/order-sheet-fields";
import { createDb } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { aiExtractionFields, aiExtractions, aiFieldCorrections } from "../db/schema";

/**
 * 印字由来の 8 欄の正答率。
 *
 * ```
 * 正答率 = そのまま採用された欄 ÷ (そのまま採用 + 人が直した)
 * ```
 *
 * ⚠⚠ **欄単位で数える。** 明細が n 行あれば明細の欄は n 回数える。
 * ⚠⚠ **合否は言わない。** 合否の判定は持たず、率だけを出す。
 * ⚠ **分母は AI が埋めた欄だけ。** 人が埋める 6 欄は入れない (AI は埋めないので当然)。
 *   どれが 8 欄かは `order-sheets/lib/order-sheet-fields.ts` が唯一の正。
 * ⚠ **最新の版だけを数える。** 読み取りをやり直すと古い版が `is_current = false` で残る。
 *   絞らないと、やり直すたびに分母が膨らむ。
 */

export interface AccuracyReport {
  overall: { accepted: number; corrected: number; rate: number | null };
  byField: { fieldKey: string; accepted: number; corrected: number; rate: number | null }[];
  byErrorKind: { errorKind: string; count: number }[];
}

const rateOf = (accepted: number, corrected: number): number | null => {
  const total = accepted + corrected;
  // ⚠ 1 件も無いときに 0 を返さない。**「0%」と「まだ測っていない」は別物。**
  return total === 0 ? null : accepted / total;
};

export async function readAccuracy(env: Bindings): Promise<AccuracyReport> {
  const db = createDb(env);
  const targets = aiFieldTargets();
  const tables = [...new Set(targets.map((target) => target.table))];
  /*
   * (表, 列) の組で照合する。
   * ⚠⚠ **明細の「列」は xlsx の番地**（`"H16"` など。以前は相対の鍵だった）、
   *   ヘッダも番地（`"J7"` など）、取引先と写真だけが物理の列名。
   * ⚠⚠ **来歴の行は書き換えない**ので、昔の世代（`"H:0"` / `"size_text"`）が混ざっている。
   *   `fieldKeyOfTarget()` が**どの世代でも引ける**ようにしてある — 読めなくすると
   *   **正答率の分母がその分だけ減って、率が嘘になる**。
   * ⚠ 表まで見るのは、同じ名前の欄を取り違えないため
   *   （ヘッダの `SHIP` と明細の Ship date は別の欄）。
   */

  const [aiRows, corrections] = await Promise.all([
    db
      .select({
        targetTable: aiExtractionFields.targetTable,
        targetRowId: aiExtractionFields.targetRowId,
        targetColumn: aiExtractionFields.targetColumn,
      })
      .from(aiExtractionFields)
      .innerJoin(aiExtractions, eq(aiExtractions.id, aiExtractionFields.aiExtractionId))
      .where(
        and(inArray(aiExtractionFields.targetTable, tables), eq(aiExtractions.isCurrent, true)),
      ),
    db
      .select({
        targetTable: aiFieldCorrections.targetTable,
        targetRowId: aiFieldCorrections.targetRowId,
        targetColumn: aiFieldCorrections.targetColumn,
        errorKind: aiFieldCorrections.errorKind,
      })
      .from(aiFieldCorrections)
      .where(inArray(aiFieldCorrections.targetTable, tables)),
  ]);

  const correctedCells = new Set(
    corrections
      .filter((row) => row.targetRowId)
      .map((row) => `${row.targetTable}|${row.targetRowId}|${row.targetColumn}`),
  );

  const perField = new Map<OrderSheetFieldKey, { accepted: number; corrected: number }>();
  for (const row of aiRows) {
    const fieldKey = fieldKeyOfTarget(row.targetTable, row.targetColumn);
    // AI の 8 欄でないもの (読み取り段の記録など) は数えない。
    if (!fieldKey || !row.targetRowId) continue;

    const tally = perField.get(fieldKey) ?? { accepted: 0, corrected: 0 };
    if (correctedCells.has(`${row.targetTable}|${row.targetRowId}|${row.targetColumn}`)) {
      tally.corrected += 1;
    } else {
      tally.accepted += 1;
    }
    perField.set(fieldKey, tally);
  }

  const byErrorKind = new Map<string, number>();
  for (const row of corrections) {
    if (!fieldKeyOfTarget(row.targetTable, row.targetColumn)) continue;
    byErrorKind.set(row.errorKind, (byErrorKind.get(row.errorKind) ?? 0) + 1);
  }

  // ⚠ 欄は 8 つとも出す。**0 件の欄が見えることに意味がある**
  //   (読み落としている欄がどれかは、率ではなく件数で分かる)。
  const byField = (Object.keys(ORDER_SHEET_FIELDS) as OrderSheetFieldKey[])
    .filter(isAiField)
    .map((key) => {
      const tally = perField.get(key) ?? { accepted: 0, corrected: 0 };
      return { fieldKey: key, ...tally, rate: rateOf(tally.accepted, tally.corrected) };
    });

  const accepted = byField.reduce((sum, row) => sum + row.accepted, 0);
  const corrected = byField.reduce((sum, row) => sum + row.corrected, 0);

  return {
    overall: { accepted, corrected, rate: rateOf(accepted, corrected) },
    byField,
    byErrorKind: [...byErrorKind].map(([errorKind, count]) => ({ errorKind, count })),
  };
}
