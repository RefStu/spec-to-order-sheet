import { and, eq, inArray } from "drizzle-orm";
import { createDb, insertInChunks } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import {
  aiExtractionFields,
  aiExtractionPayloads,
  aiExtractions,
  aiJobs,
  reviewTasks,
} from "../db/schema";
import { LOW_CONFIDENCE_100, type FieldRecord } from "../lib/extraction-fields";
import { uuidv7 } from "../lib/uuid-v7";

/**
 * 1 回の読み取りの結果を残す。
 *
 * ⚠ **モデルの生出力をそのまま `ai_extraction_payloads.raw_output` に残す。**
 *   プロンプトを変えて読み直したときに比べられるようにするため。
 * ⚠ 読み直しは `ai_extractions.version` を上げて行い、**古い版は `is_current = false` で残す**。
 *   消さないのは、どの版でどの正答率が出たかを後から辿れるようにするため。
 */
export async function recordExtraction(
  env: Bindings,
  input: {
    aiJobId: string;
    poDocumentId: string;
    rawOutput: string;
    promptSnapshot?: string | null;
    fields: FieldRecord[];
  },
): Promise<{ extractionId: string; version: number }> {
  const db = createDb(env);

  // 同じ原本の前の版を降ろす。
  const previous = await db
    .select({ version: aiExtractions.version })
    .from(aiExtractions)
    .where(eq(aiExtractions.poDocumentId, input.poDocumentId));
  const version = previous.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  if (previous.length > 0) {
    await db
      .update(aiExtractions)
      .set({ isCurrent: false })
      .where(eq(aiExtractions.poDocumentId, input.poDocumentId));
  }

  const extractionId = uuidv7();
  const lowConfidence = input.fields.filter((f) => f.confidence < LOW_CONFIDENCE_100);
  const now = new Date();

  await db.insert(aiExtractions).values({
    id: extractionId,
    aiJobId: input.aiJobId,
    poDocumentId: input.poDocumentId,
    version,
    isCurrent: true,
    fieldCount: input.fields.length,
    lowConfidenceCount: lowConfidence.length,
    overallConfidence: overallOf(input.fields),
    createdAt: now,
  });

  await db.insert(aiExtractionPayloads).values({
    id: uuidv7(),
    aiExtractionId: extractionId,
    rawOutput: input.rawOutput,
    promptSnapshot: input.promptSnapshot ?? null,
    createdAt: now,
  });

  /*
   * ⚠ **欄 1 つ = 1 行。** ここを省くと塗り分けも正答率も出せない。
   * ⚠⚠ **1 文にまとめない。** D1 の bind 変数は 1 文 100 個まで。この表は 12 列なので
   *   9 行でもう超える (3 明細の発注書で 26 行になる)。
   *   落ちると consumer が retry し、writePurchaseOrder が走り直して**同じ帳票から
   *   2 通目の発注書ができる。** 分けて投げること (shared/db.ts)。
   */
  await insertInChunks(
    input.fields.map((field) => ({
      id: uuidv7(),
      aiExtractionId: extractionId,
      targetTable: field.targetTable,
      targetRowId: field.targetRowId,
      targetColumn: field.targetColumn,
      rawValue: field.rawValue,
      normalizedValue: field.normalizedValue,
      confidence: field.confidence,
      needsReview: field.confidence < LOW_CONFIDENCE_100,
      pageNo: field.pageNo,
      // ⚠ bbox は入れない。モデルは座標を知らないので、訊けば推測で答えてしまう。
      //   辿れるのは page_no まで (原本のテキスト層があれば後から足せる)。
      bboxJson: null,
      createdAt: now,
    })),
    (chunk) => db.insert(aiExtractionFields).values(chunk),
  );

  // 確信度が低い欄だけ人に回す (「全部を人が見る」運用にしないのが設計の狙い)。
  if (lowConfidence.length > 0) {
    await db.insert(reviewTasks).values({
      id: uuidv7(),
      kind: "low_confidence_field",
      targetKind: "po_document",
      targetId: input.poDocumentId,
      title: `確信度の低い欄が ${lowConfidence.length} 件あります`,
      detail: lowConfidence
        .map((f) => `${f.targetTable}.${f.targetColumn} (${f.confidence})`)
        .join("\n"),
      priority: "normal",
      status: "open",
      createdAt: now,
    });
  }

  return { extractionId, version };
}

/**
 * ORDER SHEET に転記した 8 欄を記録する。
 *
 * ⚠⚠ **`recordExtraction()` を使い回さないこと。** あちらは `po_document_id` で版を数えて
 *   同じ原本の版をまとめて `is_current = false` に倒す。ORDER SHEET の生成は原本 1 通に
 *   紐づかない (案件の全帳票から 1 枚を組む) ので、あちらを呼ぶと**読み取りの版を
 *   巻き添えで降ろしてしまう**。だから版は「その案件の order_sheet_generate ジョブ」で数える。
 * ⚠ 確信度は**転記元から引き継ぐ**。転記で新しい確信度は生まれない (generator を見ること)。
 * ⚠ review_tasks は積まない。低い確信度は読み取りの時点で既に積まれている。
 */
export async function recordOrderSheetFields(
  env: Bindings,
  input: { aiJobId: string; caseId: string; rawOutput: string; fields: FieldRecord[] },
): Promise<{ extractionId: string; version: number }> {
  const db = createDb(env);

  // この案件の過去の生成ジョブ = 版の数え先。
  const jobs = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(and(eq(aiJobs.caseId, input.caseId), eq(aiJobs.jobType, "order_sheet_generate")));
  const jobIds = jobs.map((row) => row.id);

  const previous =
    jobIds.length > 0
      ? await db
          .select({ id: aiExtractions.id, version: aiExtractions.version })
          .from(aiExtractions)
          .where(inArray(aiExtractions.aiJobId, jobIds))
      : [];
  const version = previous.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  if (previous.length > 0) {
    await db
      .update(aiExtractions)
      .set({ isCurrent: false })
      .where(
        inArray(
          aiExtractions.id,
          previous.map((row) => row.id),
        ),
      );
  }

  const extractionId = uuidv7();
  const now = new Date();

  await db.insert(aiExtractions).values({
    id: extractionId,
    aiJobId: input.aiJobId,
    // ⚠ 原本 1 通に紐づかない (案件の全帳票から 1 枚を組む) ので空。
    poDocumentId: null,
    version,
    isCurrent: true,
    fieldCount: input.fields.length,
    lowConfidenceCount: input.fields.filter((f) => f.confidence < LOW_CONFIDENCE_100).length,
    overallConfidence: overallOf(input.fields),
    createdAt: now,
  });

  await db.insert(aiExtractionPayloads).values({
    id: uuidv7(),
    aiExtractionId: extractionId,
    rawOutput: input.rawOutput,
    promptSnapshot: null,
    createdAt: now,
  });

  // ⚠ **欄 1 つ = 1 行。** これが無いと画面の塗り分けも正答率も出せない。
  // ⚠⚠ D1 の bind 変数は 1 文 100 個まで。8 欄 × 明細の数なので必ず分けて投げる。
  await insertInChunks(
    input.fields.map((field) => ({
      id: uuidv7(),
      aiExtractionId: extractionId,
      targetTable: field.targetTable,
      targetRowId: field.targetRowId,
      targetColumn: field.targetColumn,
      rawValue: field.rawValue,
      normalizedValue: field.normalizedValue,
      confidence: field.confidence,
      needsReview: field.confidence < LOW_CONFIDENCE_100,
      pageNo: field.pageNo,
      bboxJson: null,
      createdAt: now,
    })),
    (chunk) => db.insert(aiExtractionFields).values(chunk),
  );

  return { extractionId, version };
}

function overallOf(fields: FieldRecord[]): number | null {
  if (fields.length === 0) return null;
  const total = fields.reduce((sum, field) => sum + field.confidence, 0);
  return Math.round(total / fields.length);
}

/**
 * その行・その列を AI が埋めたか (画面の塗り分けと正答率が引く)。
 *
 * ⚠ **最新の版だけを見る。** 読み取りをやり直すと古い版の行が残る
 *   (`is_current = false`)。絞らないと**古い確信度が画面に出続ける**。
 */
export async function findFieldRecord(
  env: Bindings,
  target: { table: string; rowId: string; column: string },
) {
  const [row] = await createDb(env)
    .select({
      id: aiExtractionFields.id,
      rawValue: aiExtractionFields.rawValue,
      normalizedValue: aiExtractionFields.normalizedValue,
      confidence: aiExtractionFields.confidence,
      needsReview: aiExtractionFields.needsReview,
      pageNo: aiExtractionFields.pageNo,
      bboxJson: aiExtractionFields.bboxJson,
    })
    .from(aiExtractionFields)
    .innerJoin(aiExtractions, eq(aiExtractions.id, aiExtractionFields.aiExtractionId))
    .where(
      and(
        eq(aiExtractionFields.targetTable, target.table),
        eq(aiExtractionFields.targetRowId, target.rowId),
        eq(aiExtractionFields.targetColumn, target.column),
        eq(aiExtractions.isCurrent, true),
      ),
    )
    .limit(1);
  return row ?? null;
}
