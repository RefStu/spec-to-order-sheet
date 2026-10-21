import type { Bindings } from "../../../shared/hono";

/**
 * 案件を起こす (帳票 1 通につき案件が 1 件起きる)。
 *
 * ⚠⚠ **`cases` は別の feature の持ち物なので、ここから DB を触らない。**
 *   別の feature のデータが必要なときは、その feature の API を経由する。
 *   そのためservice binding `env.CASES` の RPC で起こす (書き戻しの `updateCase` と同じ口)。
 * ⚠⚠ **自分の `/api/cases` を `fetch()` で叩かないこと。** Cloudflare では、Worker から
 *   同じ zone の自分の route への subrequest はその Worker を通らずに origin へ行く。
 *   origin が無い構成では 522 になり、アップロードが 502 で落ちる。
 *   wrangler dev では自分に届くので、ローカルでは再現しない。
 */
export class CaseCreationFailed extends Error {}

export async function createCase(
  env: Pick<Bindings, "CASES">,
  input: { partner?: string; specNo?: string },
): Promise<string> {
  let caseId: unknown;
  try {
    caseId = await env.CASES.createCase(input);
  } catch (error) {
    throw new CaseCreationFailed(
      `案件を起こせませんでした (env.CASES.createCase): ${error instanceof Error ? error.message : "不明なエラー"}。` +
        "案件を起こす処理は features/cases の担当です。" +
        "`caseId` を指定してアップロードすれば、この呼び出しは行われません。",
    );
  }
  if (typeof caseId !== "string" || caseId.length === 0) {
    throw new CaseCreationFailed("env.CASES.createCase が caseId を返しませんでした。");
  }
  return caseId;
}
