import { zValidator } from "@hono/zod-validator";
import { createApp } from "../../../shared/hono";
import { createCaseInput, updateCaseInput } from "../schema";
import {
  CaseNoTaken,
  createCase,
  getCase,
  getJobStatus,
  listCases,
  partnerExists,
  updateCase,
} from "../services/case-service";
import { seedDemoCases } from "../services/seed";

/**
 * /api/cases 配下 (prefix は app/routes.gen.ts が付ける)。
 *
 * ⚠ **メソッドチェーンのまま書くこと。** 途中で変数に代入すると hc の RPC 型が落ちる。
 * ⚠ 帳票の一覧 (原本) は **feature `purchase-orders` の /api/purchase-orders/documents** が出す。
 *   /api/cases/* は feature `cases` にしかマウントできないので、ここには置かない。
 */
export const routes = createApp()
  /** 案件一覧。サインイン後の既定の画面が読む。 */
  .get("/", async (c) => c.json(await listCases(c.env.DB)))

  /**
   * ★ 案件を起こす。**取り込みパイプライン専用の口。**
   * ⚠ アップロード (`purchase-orders/services/case-client.ts`) はもうここを叩かない。
   *   Worker から自分の route への fetch は Worker を通らず、origin が無い構成では 522 になるため、
   *   `entrypoint.ts` の RPC `createCase` で起こす。
   *
   * ⚠ **画面には「案件を作る」導線を足さない** (案件番号は採番しない。人に案件番号を
   *   決めさせない)。「案件を先に作らせない」は画面の話で、
   *   帳票が届いて案件が起きるこの経路はむしろ正。
   * ⚠⚠ **本文が空でも 201 を返す。** 取り込み側はアップロードの時点で `{}` のまま呼ぶ
   *   (その時点では取引先も製造番号もまだ読めていない)。ここで 400 を返すと
   *   アップロードが 502 で落ち、しかも R2 に書いたファイルは巻き戻らない。
   *   そのため **この 1 本だけ zValidator を使わない** — zValidator は本文が無いと
   *   JSON の parse で 400 にしてしまう。
   */
  .post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const parsed = createCaseInput.safeParse(body);
    const caseId = await createCase(c.env.DB, parsed.success ? parsed.data : {});
    return c.json({ caseId }, 201);
  })

  /**
   * ⚠ ローカル専用。案件を手で作らせる導線ではない (案件番号は人に決めさせない)。
   *   取り込みが動くまで一覧が空のままだと画面を確かめられないので、
   *   **架空の案件**を入れるためだけに置いてある。条件は代替サインインと同じ。
   */
  .post("/dev-seed", async (c) => {
    if (c.env.GIP_PROJECT_ID?.trim() || c.env.AUTH_DEV_BYPASS !== "1") {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(await seedDemoCases(c.env.DB));
  })

  /**
   * ★ ジョブ 1 件の状態。アップロード直後と「やり直す」の追跡がこれを 2〜15 秒で引く。
   *
   * ⚠⚠ **`.get("/:caseId")` より前に置くこと。** `/jobs/:jobId` は 2 セグメントなので
   *   1 セグメントの `/:caseId` とは衝突しないが、**裸の `/jobs` を足すと食われる**
   *   (`caseId === "jobs"` になる)。`/dev-seed` が同じ理由で前にある。
   * ⚠ 一覧 (`GET /`) は 5 つの JOIN が走る。3 秒ごとに引かせないためにこの口がある。
   */
  .get("/jobs/:jobId", async (c) => {
    const found = await getJobStatus(c.env.DB, c.req.param("jobId"));
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  })

  .get("/:caseId", async (c) => {
    const found = await getCase(c.env.DB, c.req.param("caseId"));
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  })

  /**
   * ★ 読み取りが終わってから案件を埋める。**取引先と製造番号が分かるのは読み取りの後**
   *   なので、これが無いと案件一覧が「取引先未確定」のままになる。
   *
   * ⚠ `partnerId` は取引先の **id** (POST の `partner` は名前の文字列で、別物)。
   * ⚠ 欄を NULL には戻せない (case-service.ts の updateCase を見ること)。
   */
  .patch("/:caseId", zValidator("json", updateCaseInput), async (c) => {
    const patch = c.req.valid("json");
    // ⚠ feature をまたぐ FK は張っていないので、ここで見ないと参照先の無い行が黙ってできる
    //   (一覧の LEFT JOIN が外れて「(取引先未設定)」になるだけで、気付けない)。
    if (patch.partnerId && !(await partnerExists(c.env.DB, patch.partnerId))) {
      return c.json({ error: "unknown_partner" }, 400);
    }
    try {
      const updated = await updateCase(c.env.DB, c.req.param("caseId"), patch);
      return updated ? c.json(updated) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      // case_no は UNIQUE。ぶつかったら 500 ではなく 409 で返す。
      if (error instanceof CaseNoTaken) return c.json({ error: "case_no_taken" }, 409);
      throw error;
    }
  });
