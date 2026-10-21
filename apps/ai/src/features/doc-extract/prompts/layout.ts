import { COMMON_OUTPUT, COMMON_ROLE, COMMON_RULES, PROMPT_SECTIONS } from "./common";

/**
 * ★★ **指示文の組み立てはここ 1 か所。**
 *
 * ⚠⚠ **節の見出しと並びを各ノードのファイルに書かない。** 役割が 5 つあるので、
 *   書き写すと必ずどれかがずれる。ノードのファイルが持つのは**中身だけ**。
 * ⚠ 様式ごとの注意書きは**いちばん最後**に足す (空なら足さない)。
 *   `prompts.test.ts` が「様式の差分は末尾」を固定している。
 */
export interface PromptBody {
  /** `# 概要` … ⚠ **何をしてほしいのか**を短く。ルールより前に出る。 */
  overview: string;
  /** `# ルール` に足す、その役割だけの条。共通の 6 条の**後ろ**に付く。 */
  rules?: string;
  /** `# 取り出すもの` … 欄 → どこから取るか の表。⚠ **欄の名前は契約のとおり**にする。 */
  fields: string;
  /** `# 出力形式`。既定は `COMMON_OUTPUT`。 */
  output?: string;
}

/** 節を 1 つ組み立てる (中身が空なら節ごと出さない)。 */
function section(heading: string, body: string): string | null {
  const text = body.trim();
  return text.length === 0 ? null : `${heading}\n\n${text}`;
}

export function buildPrompt(body: PromptBody, formNotes = ""): string {
  const [role, overview, rules, fields, output] = PROMPT_SECTIONS;
  return [
    section(role, COMMON_ROLE),
    section(overview, body.overview),
    // ⚠ 共通の 6 条が先、役割だけの条が後ろ。**6 条はどの役割にも必ず入る。**
    section(
      rules,
      [COMMON_RULES, (body.rules ?? "").trim()].filter((part) => part.length > 0).join("\n"),
    ),
    section(fields, body.fields),
    section(output, body.output ?? COMMON_OUTPUT),
    formNotes.trim(),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n\n");
}
