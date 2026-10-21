import { createApp } from "../../../shared/hono";
import {
  DeleteDocumentFailed,
  deleteDocument,
  listDocuments,
  ReextractFailed,
  reextractDocument,
} from "../services/intake-service";

/**
 * /api/purchase-orders 配下。
 *
 * ⚠ `GET /api/cases/:caseId/documents` にはしない。
 *   **app/routes.gen.ts は feature 名で /api/<feature> にマウントするので
 *   /api/cases/* は feature `cases` にしか置けない。**
 *   帳票の原本 (po_documents) は purchase-orders の表なので、ここに移してある。
 *   → `GET /api/purchase-orders/documents?caseId=…`
 * ⚠ **メソッドチェーンのまま書くこと。** 途中で変数に代入すると hc の RPC 型が落ちる。
 */
export const routes = createApp()
  /** 案件詳細の発注書区画。届いた帳票の一覧と、原本 PDF の場所。 */
  .get("/documents", async (c) => {
    const caseId = c.req.query("caseId") ?? "";
    if (!caseId) return c.json({ caseId, documents: [] });

    const rows = await listDocuments(c.env, caseId);
    return c.json({
      caseId,
      documents: rows.map((row) => ({
        documentId: row.documentId,
        docKind: row.docKind,
        // ⚠ **様式は当面つかない。** po_documents に form_profile_id が無く、様式の判定も
        //   まだ無い。PoC が扱う様式は 1 つだけだが、**判定していないものを名乗らせない**
        //   (「埋まらない欄がある方が正しい」)。
        formPattern: null as string | null,
        receivedOn: row.receivedAt.toISOString().slice(0, 10),
        pageCount: row.pageCount,
        extractionStatus: row.status,
        /**
         * ⚠⚠ **認証付きのパスをそのまま返す。署名付き URL は作らない。**
         *   GIP 以外の認証経路を増やさないため。このパスは authMiddleware の内側で、
         *   `isPublicApiPath()` は完全一致なので **素の <a href> は 401 になる。**
         *   画面は `Authorization: Bearer` 付きで fetch し、`URL.createObjectURL(blob)` で開くこと。
         */
        originalUrl: `/api/files/${row.fileId}/original`,
      })),
    });
  })

  /**
   * 案件詳細の「読み取りをやり直す」。前の結果は `ai_extractions.version` を上げて残る。
   * ⚠ 本体 (purchase_orders / revision_requests) はここでは消さずに積み直す。
   *   取り下げは読み取りが成功してから `document-writer.ts` が書き込みと同じ batch で行う
   *   (先に消すと、積み直しが失敗したとき案件から帳票が消えたままになる)。
   */
  .post("/documents/:documentId/reextract", async (c) => {
    try {
      const { jobId } = await reextractDocument(c.env, c.req.param("documentId"));
      return c.json({ jobId, status: "accepted" as const }, 202);
    } catch (error) {
      if (error instanceof ReextractFailed) {
        // not_found = その帳票が無い / case_unknown = 案件を逆引きできない。
        return c.json({ error: error.message }, error.message === "not_found" ? 404 : 409);
      }
      throw error;
    }
  })

  /**
   * ★ 届いた帳票を取り消す。
   *
   * ⚠ **物理削除ではない。** `deleted_at` を入れ、その帳票から作った行も降ろす。
   * ⚠ **`released` の案件は 409。** 不可逆点を越えた案件の根拠は抜けない。
   * ⚠ 画面は**確認ダイアログを挟んでから**呼ぶこと (元に戻せない操作)。
   */
  .delete("/documents/:documentId", async (c) => {
    try {
      const result = await deleteDocument(c.env, c.req.param("documentId"));
      return c.json({ ok: true as const, ...result });
    } catch (error) {
      if (error instanceof DeleteDocumentFailed) {
        return c.json({ error: error.message }, error.message === "not_found" ? 404 : 409);
      }
      throw error;
    }
  });
