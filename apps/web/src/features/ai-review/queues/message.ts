import { z } from "zod";

/**
 * キューに積むメッセージ。
 *
 * ⚠ **キューの body は信用しない。** JSON に落ちて戻ってくるだけなので consumer が zod で
 *   検証する。形が違うものは `ack()` (再試行しても直らない)。
 * ⚠ **中身を増やさない。** ジョブの内容は `ai_jobs` の行が持っている
 *   (job_type / target_kind / target_id / input_file_id)。二重に持つとずれる。
 * ⚠ 例外は `caseId` の 1 つだけ。**`po_documents` にも案件の列が無い**
 *   (案件はどこからもソフト参照しか張っていない) ので、
 *   投入したときに分かっている案件をここで運ぶ。
 * ⚠⚠ **資格化情報も URL も載せない。** 案件の書き戻しは service binding の RPC
 *   (`env.CASES`) で行うので、consumer は自分のホスト名もトークンも要らない。
 */
export const jobMessage = z.object({
  jobId: z.string().min(1),
  caseId: z.string().min(1),
});
export type JobMessage = z.infer<typeof jobMessage>;
