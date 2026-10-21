import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "../../shared/hono";
import { createCaseInput } from "./schema";
import { createCase, partnerExists, updateCase } from "./services/case-service";

/**
 * ★ 取り込みパイプラインが案件を起こし、埋めるための RPC の口。
 *
 * ⚠⚠ **なぜ HTTP ではないのか。** 取引先と製造番号が分かるのは**キューの consumer の中**で、
 *   そこには利用者のリクエストが無い (絶対 URL も Authorization も無い)。
 *   アップロード (リクエストの文脈がある) からも HTTP では呼べない。Worker から同じ zone の
 *   自分の route への subrequest は Worker を通らずに origin へ行き、origin が無い構成では 522 になる
 *   (アップロードが 502 で落ちる。purchase-orders/services/case-client.ts)。
 *   自分の `/api/cases` を HTTP で叩こうとすると `authMiddleware` に当たるので、
 *   パイプライン用の資格情報を別に持たせるしかなくなる。
 *   **service binding の RPC は `fetch` ハンドラを通らない**ので middleware も通らず、
 *   「誰が呼べるか」は wrangler.jsonc の binding 宣言だけで決まる。名乗るものが要らない。
 * ⚠ **公開されない。** RPC は Worker 間でしか呼べず、URL も生えない。
 * ⚠ ここに画面向けの処理を足さない。HTTP の口は `api/routes.ts` が持つ。
 *   ここは**取り込みが案件を起こし、書き戻すためだけ**の最小の面。
 */
export class CasesEntrypoint extends WorkerEntrypoint<Bindings> {
  /**
   * アップロードのたびに案件を 1 件起こす。
   *
   * ⚠ **本文はすべて任意** (アップロードの時点では取引先も製造番号も読めていない)。
   *   形が違っても断らず、`POST /api/cases` と同じく空として扱う (schema.ts の createCaseInput)。
   * @returns 起こした案件の ID。
   */
  async createCase(input: { partner?: string; specNo?: string }): Promise<string> {
    const parsed = createCaseInput.safeParse(input);
    return createCase(this.env.DB, parsed.success ? parsed.data : {});
  }

  /**
   * 読み取りが終わってから案件を埋める。
   *
   * ⚠ 欄を NULL には戻せない (case-service.ts が COALESCE で埋めるため)。
   * ⚠ `partnerId` は取引先の **id**。
   * @returns 更新できたか。案件が無い / 取引先が実在しないときは false。
   */
  async updateCase(
    caseId: string,
    patch: { partnerId?: string; specNo?: string; caseNo?: string; title?: string },
  ): Promise<boolean> {
    // feature をまたぐ FK は張っていないので、ここで見ないと参照先の無い行が黙ってできる。
    if (patch.partnerId && !(await partnerExists(this.env.DB, patch.partnerId))) return false;

    const updated = await updateCase(this.env.DB, caseId, patch);
    return updated !== undefined;
  }
}
