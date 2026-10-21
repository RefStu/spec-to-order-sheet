import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { aiJobs } from "../../ai-review/db/schema";
import { cancelInProgressJobs, enqueueJob } from "../../ai-review/services/job-service";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import { orderSheets } from "../../order-sheets/db/schema";
import { createDb, runBatch } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { files } from "../../files/db/schema";
import { revisionRequests } from "../../revisions/db/schema";
import { poDocuments, purchaseOrders } from "../db/schema";

/**
 * 読み取りジョブの種類 (`ai_jobs.job_type`)。
 *
 * ⚠⚠ **1 本しかない。** 実物は 1 つの PDF に発注書と依頼書が内包されて届くので、
 *   「種類を選んでから読む」形が成り立たない。**ai 側の workflow が
 *   分類してから読む**ので、web は種類を決めずに積む。
 */
const DOC_EXTRACT_JOB = "doc_extract" as const;

/**
 * 受け取った帳票を登録し、読み取りをキューに積む。
 *
 * ⚠ `po_documents` は**発注書と依頼書の両方**が入る 1 つの表。
 *   ⚠⚠ **1 つの PDF = 1 行。** 内包 PDF でも 2 行に割らない
 *   (`file_id` で重複を弾き、版は `po_document_id` で数え、やり直しは PDF 丸ごとのため)。
 * ⚠ **登録の時点では `doc_kind` は `unknown`。** 何が入っているかは読んで初めて分かる
 *   (判定していないものを名乗らせない)。確定させるのは `document-writer.ts`。
 * ⚠ `file_pages` はここでは作らない。**ページ数は Worker では数えられない** (PDF を
 *   解析できない) ので、読み取りの結果が返ってきたときに consumer が作る。
 */
export async function registerDocument(
  env: Bindings,
  input: { fileId: string; caseId: string },
): Promise<{ documentId: string; jobId: string }> {
  const db = createDb(env);

  // 同じファイルを 2 回登録しない (二重取り込みでアップロードが既存の fileId を返したとき)。
  // ⚠⚠ **消した帳票は数えない。** 数えると、消したものを入れ直そうとしたときに
  //   消えた行をそのまま返してしまう (画面には出ないのに「登録済み」になる)。
  const [existing] = await db
    .select({ id: poDocuments.id })
    .from(poDocuments)
    .where(and(eq(poDocuments.fileId, input.fileId), isNull(poDocuments.deletedAt)))
    .limit(1);

  const documentId = existing?.id ?? uuidv7();
  if (!existing) {
    await db.insert(poDocuments).values({
      id: documentId,
      fileId: input.fileId,
      docKind: "unknown",
      // ⚠ 取引先は**読み取り前には分からない** (発注書に印字されている)。空のまま入れる。
      partnerId: null,
      status: "received",
      receivedAt: new Date(),
    });
  }

  const jobId = await enqueueJob(env, {
    jobType: DOC_EXTRACT_JOB,
    targetKind: "po_document",
    targetId: documentId,
    caseId: input.caseId,
    inputFileId: input.fileId,
  });

  return { documentId, jobId };
}

/** 案件詳細の発注書区画に出す 1 行。 */
export interface CaseDocument {
  documentId: string;
  fileId: string;
  /** ⚠ 読む前は `unknown`、内包 PDF は `mixed`。 */
  docKind: "purchase_order" | "spec_sheet" | "mixed" | "unknown";
  status: "received" | "parsing" | "parsed" | "needs_review" | "confirmed" | "failed";
  receivedAt: Date;
  /**
   * PDF のページ数 (`files.page_count`)。
   *
   * ⚠ **PoC では常に空。** Worker は PDF を解析できず、モデルに数えさせると
   *   捏造の余地が出る (指示文は「分からなければ推測せず null」)。
   *   埋めるなら file_pages を作る工程を先に入れること。
   */
  pageCount: number | null;
}

/**
 * 案件に届いた帳票の一覧 (案件詳細の発注書区画)。
 *
 * ⚠⚠ **`po_documents` に案件の列が無い。** 案件との結び付きは 2 つの経路で辿る。
 *   ① `ai_jobs.case_id` … **アップロードの直後から引ける。**読み取り中の帳票もここに出る
 *   ② `purchase_orders.case_id` / `revision_requests.case_id` … 読み取りが終わってから
 *   ① だけで足りるはずだが、`ai_jobs.case_id` を足す前に積まれたジョブは空なので ② も残す。
 *   **① が無いと、読み取りが終わるまで画面に 1 件も出ない。**
 * ⚠ 並びは `received_at` 昇順に固定する (inArray は順序を保証しない)。
 */
export async function listDocuments(env: Bindings, caseId: string): Promise<CaseDocument[]> {
  const db = createDb(env);

  const [fromJobs, fromPo, fromSpec] = await Promise.all([
    db
      .select({ documentId: aiJobs.targetId })
      .from(aiJobs)
      .where(and(eq(aiJobs.caseId, caseId), eq(aiJobs.targetKind, "po_document"))),
    db
      .select({ documentId: purchaseOrders.poDocumentId })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.caseId, caseId), isNull(purchaseOrders.deletedAt))),
    db
      .select({ documentId: revisionRequests.sourcePoDocumentId })
      .from(revisionRequests)
      .where(and(eq(revisionRequests.caseId, caseId), isNull(revisionRequests.deletedAt))),
  ]);

  const documentIds = [
    ...new Set(
      [...fromJobs, ...fromPo, ...fromSpec]
        .map((row) => row.documentId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (documentIds.length === 0) return [];

  const rows = await db
    .select({
      documentId: poDocuments.id,
      fileId: poDocuments.fileId,
      docKind: poDocuments.docKind,
      status: poDocuments.status,
      receivedAt: poDocuments.receivedAt,
      pageCount: files.pageCount,
    })
    .from(poDocuments)
    // 原本のページ数は files 側が持つ。R2 の実体もこの行から引く。
    .leftJoin(files, eq(files.id, poDocuments.fileId))
    // ⚠ 消した帳票は出さない (記録としては残す)。
    .where(and(inArray(poDocuments.id, documentIds), isNull(poDocuments.deletedAt)))
    .orderBy(poDocuments.receivedAt);

  return rows;
}

/**
 * 読み取りをやり直す (案件詳細の「読み取りをやり直す」)。
 *
 * ⚠⚠ **前の結果は版として残る。** `recordExtraction()` が `ai_extractions.version` を上げ、
 *   古い版を `is_current = false` にする。
 * ⚠⚠ **本体 (purchase_orders / revision_requests) はここでは消さない。** 取り下げは
 *   `document-writer.ts` が**読めてから**、書き込みと同じ batch で行う。
 *   `writePurchaseOrder()` は毎回 `uuidv7()` で新しい行を作るので、取り下げないと
 *   同じ帳票から 2 通目ができ、案件一覧の通数が二重になる
 *   (`cases` の `listCases` は `deleted_at IS NULL` で数えている)。
 * ⚠ 案件は `ai_jobs.case_id` から引く。`po_documents` に案件の列が無いため。
 */
export class ReextractFailed extends Error {}

export async function reextractDocument(
  env: Bindings,
  documentId: string,
): Promise<{ jobId: string; caseId: string }> {
  const db = createDb(env);

  const [document] = await db
    .select({ id: poDocuments.id, fileId: poDocuments.fileId })
    .from(poDocuments)
    // ⚠ 消した帳票はやり直せない。
    .where(and(eq(poDocuments.id, documentId), isNull(poDocuments.deletedAt)))
    .limit(1);
  if (!document) throw new ReextractFailed("not_found");

  const caseId = await findCaseId(env, documentId);
  if (!caseId) {
    // 案件が引けないと、やり直しても結果の置き場所が決まらない。
    throw new ReextractFailed("case_unknown");
  }

  // ⚠⚠ **ここで前の版を消さない。**
  //   以前は「先に論理削除 → 積み直す」だったので、積み直しが失敗すると
  //   **案件から帳票が消えたままになった** (実測で通数 1 → 0)。
  //   取り下げは `document-writer.ts` が**読めてから**、書き込みと同じ batch で行う。
  await db.update(poDocuments).set({ status: "received" }).where(eq(poDocuments.id, documentId));

  // ⚠⚠ **積む前に、同じ帳票の進行中のジョブを畳む。** 畳まないと、落ちた consumer が
  //   残した `running` の行が居座り、やり直しが成功しても案件は「読み取り中」のまま
  //   回り続ける (`cases/lib/progress.ts` は進行中を失敗より優先する)。
  //   **やり直しが、人が自分で抜け出せる唯一の導線。**
  await cancelInProgressJobs(
    env,
    { targetKind: "po_document", targetId: documentId },
    "読み取りをやり直したため取り消しました",
  );

  const jobId = await enqueueJob(env, {
    jobType: DOC_EXTRACT_JOB,
    targetKind: "po_document",
    targetId: documentId,
    caseId,
    inputFileId: document.fileId,
  });

  return { jobId, caseId };
}

/** 帳票からその案件を逆引きする。`ai_jobs.case_id` が先、無ければ読み取り結果から。 */
async function findCaseId(env: Bindings, documentId: string): Promise<string | undefined> {
  const db = createDb(env);

  const [fromJob] = await db
    .select({ caseId: aiJobs.caseId })
    .from(aiJobs)
    .where(and(eq(aiJobs.targetId, documentId), eq(aiJobs.targetKind, "po_document")))
    .orderBy(desc(aiJobs.queuedAt))
    .limit(1);
  if (fromJob?.caseId) return fromJob.caseId;

  const [fromPo] = await db
    .select({ caseId: purchaseOrders.caseId })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.poDocumentId, documentId))
    .limit(1);
  if (fromPo?.caseId) return fromPo.caseId;

  const [fromSpec] = await db
    .select({ caseId: revisionRequests.caseId })
    .from(revisionRequests)
    .where(eq(revisionRequests.sourcePoDocumentId, documentId))
    .limit(1);
  return fromSpec?.caseId ?? undefined;
}

export class DeleteDocumentFailed extends Error {}

/**
 * ★ 届いた帳票を取り消す。
 *
 * ⚠⚠ **物理削除にしない。** 誰が何をしたかの記録が残らなくなる。`deleted_at` を入れて、
 *   その帳票から作った発注書・依頼書も同じ batch で降ろす。
 * ⚠⚠ **`released` の案件では断る (409)。** `released` は不可逆点で、製造が始まっている。
 *   根拠の帳票だけ消せると ORDER SHEET が宙に浮く。
 * ⚠ 消したあとは **ORDER SHEET を組み直す**。残った帳票だけで作り直せば、
 *   消した帳票の値が残らない (`generateOrderSheet()` は冪等)。
 *   ⚠ 発注書が 1 通も無くなると `OrderSheetNotGeneratable` になるが、consumer が
 *     `succeeded` に畳むので**ジョブは失敗しない**。ORDER SHEET は前の内容のまま残る。
 */
export async function deleteDocument(
  env: Bindings,
  documentId: string,
): Promise<{ caseId: string; jobId: string | null }> {
  const db = createDb(env);

  const [document] = await db
    .select({ id: poDocuments.id })
    .from(poDocuments)
    .where(and(eq(poDocuments.id, documentId), isNull(poDocuments.deletedAt)))
    .limit(1);
  if (!document) throw new DeleteDocumentFailed("not_found");

  const caseId = await findCaseId(env, documentId);
  if (!caseId) throw new DeleteDocumentFailed("case_unknown");

  // ⚠ 不可逆点を越えた案件は触らせない。
  const [sheet] = await db
    .select({ status: orderSheets.status })
    .from(orderSheets)
    .where(and(eq(orderSheets.caseId, caseId), isNull(orderSheets.deletedAt)))
    .limit(1);
  if (sheet?.status === "released") throw new DeleteDocumentFailed("released");

  const now = new Date();
  // ⚠ 帳票と、そこから作った行を**同じトランザクション**で降ろす
  //   (帳票だけ消えて中身が残ると、通数と明細が合わなくなる)。
  await runBatch(db, [
    db
      .update(purchaseOrders)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(purchaseOrders.poDocumentId, documentId), isNull(purchaseOrders.deletedAt))),
    db
      .update(revisionRequests)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(revisionRequests.sourcePoDocumentId, documentId),
          isNull(revisionRequests.deletedAt),
        ),
      ),
    db.update(poDocuments).set({ deletedAt: now }).where(eq(poDocuments.id, documentId)),
  ]);

  // ORDER SHEET を組み直す。⚠ 積めなくても削除は成立しているので投げない。
  let jobId: string | null = null;
  try {
    jobId = await enqueueJob(env, {
      jobType: "order_sheet_generate",
      targetKind: "order_sheet",
      targetId: caseId,
      caseId,
    });
  } catch (error) {
    console.warn(`[intake] ${caseId} の ORDER SHEET 組み直しを積めませんでした`, error);
  }

  return { caseId, jobId };
}
