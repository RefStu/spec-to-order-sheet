import { createApp } from "../../../shared/hono";
import { createCase, CaseCreationFailed } from "../../purchase-orders/services/case-client";
import { registerDocument } from "../../purchase-orders/services/intake-service";
import { readOriginal, storeDocument, UploadRejected } from "../services/upload-service";

/**
 * /api/files 配下。
 *
 * ⚠ **メソッドチェーンのまま書くこと。** 途中で変数に代入すると hc の RPC 型が落ちる。
 * ⚠ アップロードは multipart なので `zValidator` が使えない (JSON 前提)。手で検証する。
 *
 * R2 に預けて台帳に 1 行、帳票の登録とキュー投入、を 1 リクエストで通す。
 * 返す形は契約のまま (案件一覧の「発注書をアップロード」がこれを見る)。
 *
 * ⚠⚠ **種類 (`docKind`) を受け取らない。**
 *   実物は **1 つの PDF に発注書と新製品依頼書が内包されて**届くので、
 *   「1 ファイル = 1 種類」を人に選ばせる形が成り立たない。
 *   何が入っているかは **ai 側の workflow が分類ノードで判定する**。
 *   ⚠ **「未指定は発注書」の既定値を戻さないこと。** それは
 *     依頼書の読み取りが一度も起動しない状態を作る。
 */
export const routes = createApp()
  .post("/uploads", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "multipart/form-data で送ってください" }, 400);

    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file がありません" }, 400);

    let stored;
    try {
      stored = await storeDocument(c.env, {
        filename: file.name,
        contentType: file.type,
        body: await file.arrayBuffer(),
      });
    } catch (error) {
      if (error instanceof UploadRejected) return c.json({ error: error.message }, 400);
      throw error;
    }

    // 案件は、指定が無ければここで起こす (`cases` は別の feature の持ち物なので RPC 経由)。
    const given = form.get("caseId");
    let caseId: string;
    try {
      caseId =
        typeof given === "string" && given.length > 0 ? given : await createCase(c.env, {});
    } catch (error) {
      if (error instanceof CaseCreationFailed) return c.json({ error: error.message }, 502);
      throw error;
    }

    const { jobId } = await registerDocument(c.env, { fileId: stored.fileId, caseId });

    // ⚠ ここで Cloud Run を呼ばない。読み取りは分単位かかるので画面を待たせない。
    //   202 = 受け付けたが処理はこれから。
    return c.json(
      {
        fileId: stored.fileId,
        caseId,
        jobId,
        fileName: file.name,
        status: "accepted" as const,
      },
      202,
    );
  })
  .get("/:fileId/original", async (c) => {
    const original = await readOriginal(c.env, c.req.param("fileId"));
    if (!original) return c.json({ error: "not_found" }, 404);

    return new Response(original.body, {
      headers: {
        "content-type": original.contentType,
        // 画面では開くだけ (ダウンロードさせない)。
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(original.filename)}`,
        "cache-control": "private, max-age=60",
      },
    });
  });
