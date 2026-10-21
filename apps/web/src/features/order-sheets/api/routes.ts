import { zValidator } from "@hono/zod-validator";
import { createApp } from "../../../shared/hono";
import { UnsupportedPhotoType, UploadRejected } from "../../files/services/upload-service";
import { patchOrderSheetInput } from "../schema";
import { exportOrderSheetXlsx, TooManyLines } from "../services/order-sheet-export";
import { readOrderSheet } from "../services/order-sheet-reader";
import {
  AlreadyReleased,
  LinePhotoMissing,
  OrderSheetMissing,
  addLinePhoto,
  applyPatch,
  approveOrderSheet,
  deleteLinePhoto,
} from "../services/order-sheet-writer";

/**
 * /api/order-sheets 配下 (prefix は app/routes.gen.ts が付ける)。
 *
 * ⚠⚠ **返り値の形 (../schema.ts) を変えると画面 (features/cases) が黙って壊れる。**
 * ⚠ **メソッドチェーンのまま書くこと。** 途中で変数に代入すると hc の RPC 型が落ちる。
 */
export const routes = createApp()
  /**
   * ★ ORDER SHEET を xlsx で出す。**実物と同じ形の雛形に値を差し込む。**
   *
   * ⚠ `/:caseId` より**先**に置く (後ろに置くと caseId = "layout" として拾われる)。
   * ⚠ 出したものは R2 にも残す (承認したときの現物を見せられるように)。
   * ⚠ 素の `<a href>` では 401 になる (このパスは認証の内側)。画面は apiFetch で取ること。
   */
  .get("/:caseId/xlsx", async (c) => {
    try {
      const exported = await exportOrderSheetXlsx(c.env, c.req.param("caseId"));
      return new Response(exported.bytes as unknown as BodyInit, {
        headers: {
          "content-type": exported.contentType,
          // ⚠ ファイル名に固有名詞を入れない (案件番号か社内番号だけ)。
          "content-disposition": `attachment; filename="${exported.filename}"`,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      if (error instanceof TooManyLines) {
        // ⚠ **黙って切り捨てない。** 枠を増やすなら雛形を作り直す。
        return c.json({ error: "too_many_lines", max: error.max }, 422);
      }
      throw error;
    }
  })

  /**
   * すべての欄を同じ形で返す。
   * ⚠ ORDER SHEET がまだ無い案件 (dev-seed / 読み取り中) にも**空の枠を 200 で返す**。
   *   404 にすると画面側の対応が要る (services/order-sheet-reader.ts の emptySheet)。
   */
  .get("/:caseId", async (c) => {
    const caseId = c.req.param("caseId");
    return c.json(await readOrderSheet(c.env, caseId));
  })

  /** 人が埋める欄の保存。AI の欄を直したときは corrections が載ってくる。 */
  .patch("/:caseId", zValidator("json", patchOrderSheetInput), async (c) => {
    try {
      const sheet = await applyPatch(c.env, {
        caseId: c.req.param("caseId"),
        patch: c.req.valid("json"),
        // ⚠ ai_field_corrections.corrected_by は NOT NULL。認証は middleware が通している。
        actorUid: c.get("auth")?.uid ?? "unknown",
      });
      return c.json(sheet);
    } catch (error) {
      if (error instanceof OrderSheetMissing) return c.json({ error: "not_found" }, 404);
      throw error;
    }
  })

  /**
   * blocker が残っていれば承認させない。
   * ⚠ 判定は services/approval.ts の 1 か所だけが持つ (重さの判断を後から変えられる形)。
   */
  .post("/:caseId/approve", async (c) => {
    try {
      const result = await approveOrderSheet(c.env, {
        caseId: c.req.param("caseId"),
        actorUid: c.get("auth")?.uid ?? "unknown",
      });
      return result.ok ? c.json(result) : c.json(result, 409);
    } catch (error) {
      if (error instanceof OrderSheetMissing) return c.json({ error: "not_found" }, 404);
      // released は不可逆点。二度流さない。
      if (error instanceof AlreadyReleased) return c.json({ error: "already_released" }, 409);
      throw error;
    }
  })

  /**
   * ★ 明細に代表の図を 1 枚足す (画面の upload アイコン)。multipart の `file`。
   *
   * ⚠ 受けるのは jpeg / png だけ (415)。xlsx に埋め込めるのがその 2 つだけ。
   * ⚠ `POST /api/files/uploads` は使わない (PDF 専用で、読み取りジョブを起こす)。
   * ⚠ 返すのは ORDER SHEET 全体 (DELETE と同じ形)。画面は setQueryData で締められる。
   */
  .post("/:caseId/lines/:lineId/photos", async (c) => {
    // ⚠ multipart なので zValidator は使えない (`files/api/routes.ts` と同じく手で見る)。
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "file がありません" }, 400);
    try {
      const sheet = await addLinePhoto(c.env, {
        caseId: c.req.param("caseId"),
        lineId: c.req.param("lineId"),
        file: { filename: file.name, body: await file.arrayBuffer() },
        actorUid: c.get("auth")?.uid ?? "unknown",
      });
      return c.json(sheet);
    } catch (error) {
      if (error instanceof OrderSheetMissing || error instanceof LinePhotoMissing) {
        return c.json({ error: "not_found" }, 404);
      }
      if (error instanceof AlreadyReleased) return c.json({ error: "released" }, 409);
      if (error instanceof UnsupportedPhotoType) {
        return c.json({ error: "unsupported_media_type", message: error.message }, 415);
      }
      if (error instanceof UploadRejected) return c.json({ error: error.message }, 400);
      throw error;
    }
  })

  /**
   * ★ 明細の代表の図を 1 枚だけ外す (画面のゴミ箱)。
   *
   * ⚠⚠ **原本 (`files` / R2) は消さない。** 外したことを持つのは
   *   `order_sheet_line_photos.deleted_at` だけ (1 枚の依頼書が複数の明細に結ばれるため)。
   * ⚠ **二度目は 200** (冪等)。無い ID は 404、`released` は 409。
   * ⚠ 返すのは ORDER SHEET 全体 (PATCH と同じ形)。画面は setQueryData で締められる。
   */
  .delete("/:caseId/lines/:lineId/photos/:photoId", async (c) => {
    try {
      const sheet = await deleteLinePhoto(c.env, {
        caseId: c.req.param("caseId"),
        lineId: c.req.param("lineId"),
        photoId: c.req.param("photoId"),
      });
      return c.json(sheet);
    } catch (error) {
      if (error instanceof OrderSheetMissing || error instanceof LinePhotoMissing) {
        return c.json({ error: "not_found" }, 404);
      }
      // 現場に流したあとは根拠の絵も動かさない。
      if (error instanceof AlreadyReleased) return c.json({ error: "released" }, 409);
      throw error;
    }
  });
