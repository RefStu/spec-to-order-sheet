/**
 * ノード (workflow の段) と `ai_prompts.purpose` の対応。
 *
 * ⚠⚠ **読み取りには使われない。** 「この様式のときはこの指示文」を D1 で持つ仕組みは
 *   やめて、**ai の `prompts/` のファイル (git) が正**になった。
 *   ここが残っているのは、画面「発注書分類」が `ai_prompts` を**記録として**
 *   読み書きするときに purpose の語彙が要るため。
 * ⚠ 読み取りに戻すときは、`queues/consumer.ts` で指示文を集めて
 *   `docExtractRequest` に載せるところから作り直すこと。
 */

/** workflow のノード。`ai_prompts.purpose` と 1 対 1 で対応する。 */
export const PROMPT_ROLES = ["classify", "purchase_order", "spec_sheet"] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];

/** ノード → `ai_prompts.purpose`。**ここが唯一の対応表。** */
export const PURPOSE_BY_ROLE = {
  classify: "doc_classify",
  purchase_order: "po_extract",
  spec_sheet: "spec_sheet_extract",
} as const satisfies Record<PromptRole, string>;
