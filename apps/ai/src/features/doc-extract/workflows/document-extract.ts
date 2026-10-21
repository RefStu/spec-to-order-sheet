import { createWorkflow } from "@mastra/core/workflows";
import {
  docExtractRequestSchema,
  docExtractResponseSchema,
  documentExtractWorkflowId,
} from "../contract";
import { classifyStep } from "../steps/classify";
import { cropPicturesStep } from "../steps/crop-pictures";
import { extractStep } from "../steps/extract";
import { locatePicturesStep } from "../steps/locate-pictures";
import { linkStep } from "../steps/link";
import { readSpecNotesStep } from "../steps/read-spec-notes";

/**
 * 1 通の PDF を **分類 → 読み取り → 代表の図の場所 → 下部のメモ → 切り出し → 対応づけ** の順で処理する。
 *
 * ⚠⚠ **流れはコードが持つ。** agent に「全部よしなに」とはさせない。
 *   分類が「依頼書が 2 枚」と言えば、読み取りは**必ず 2 回**走る。
 * ⚠ id が URL と登録のキーになる。他の feature と重なると起動時に落ちる。
 */
export const documentExtractWorkflow = createWorkflow({
  id: documentExtractWorkflowId,
  description: "発注書と依頼書が内包された PDF を仕分けてから読み取る",
  inputSchema: docExtractRequestSchema,
  outputSchema: docExtractResponseSchema,
})
  .then(classifyStep)
  .then(extractStep)
  // ⚠⚠ **欄の読み取りとは別の呼び出し。** 同じ呼び出しで座標も聞いていたころ、
  //   実行ごとに区分や REMARK が落ちていた (`steps/locate-pictures.ts` の冒頭)。
  .then(locatePicturesStep)
  // ⚠ 下部のメモ (**将来は消す**)。これも欄の読み取りとは別の呼び出し
  //   (`steps/read-spec-notes.ts` の冒頭)。消すときはこの 1 行とファイルを消す。
  .then(readSpecNotesStep)
  .then(cropPicturesStep)
  // ⚠ 最後に置くのは、切り出しの結果 (どの依頼書の図が切れたか) を将来の材料にできるようにするため。
  .then(linkStep)
  .commit();
