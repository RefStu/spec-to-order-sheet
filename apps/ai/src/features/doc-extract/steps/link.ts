import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { docExtractResponseSchema, specSheetLink, type DocExtractRequest } from "../contract";
import { linkView } from "../lib/link-view";
import { addTokens, appendRawOutputs } from "../lib/node-runs";
import { emitProgress } from "../lib/progress";
import { runExtraction } from "../lib/run-extraction";
import { promptFor } from "../prompts";
import { resolveModelId } from "../../../shared/models";

export const linkStepId = "link";

/** モデルに答えさせる形。⚠ `.min(1)` は付けない (明細が 0 行の帳票がある)。 */
const linkAnswer = z.object({ links: z.array(specSheetLink) });

/**
 * ノード④: **発注書の明細と依頼書の対応づけ**だけを確かめる。
 *
 * ⚠⚠ **ORDER SHEET は組み立てない。** 欄の文字列の作り方 (Description の語・STONE の並べ方) は
 *   web 側にあり、そこが正。ここが返すのは「**どの明細がどの依頼書か**」だけ。
 * ⚠⚠ **突き合わせの規則もここには無い。** 番号の正規化は web の `matchBySpecNo()` が
 *   決定的に行う。このノードは**規則で結べなかったものの受け皿**で、web は
 *   「結べなかった明細にだけ」この答えを当てる。
 * ⚠ **画像を渡さない。** 読み取った印字 (`quote`) だけを見て答えるノードなので、
 *   `requireImages: false` で呼ぶ。
 * ⚠ 発注書が無い / 依頼書が 0 枚なら**モデルを呼ばない** (結ぶ相手が居ない)。
 */
export const linkStep = createStep({
  id: linkStepId,
  description: "発注書の明細と依頼書の対応づけを確かめる",
  inputSchema: docExtractResponseSchema,
  outputSchema: docExtractResponseSchema,
  // ⚠⚠ **`tracingContext` と `mastra` を受け取ること。** 渡さないと、この step の下の
  //   モデル呼び出しの span が丸ごと消える (`lib/run-extraction.ts` の冒頭)。
  execute: async ({ inputData, getInitData, tracingContext, mastra, writer }) => {
    const response = inputData;
    const { purchaseOrder, specSheets } = response.extraction;
    const node = { node: linkStepId, label: "発注書と依頼書を対応づける" };
    await emitProgress(writer, { ...node, stage: "shape", status: "running" });

    // ⚠ 結ぶ相手が居ない。モデルを呼ばずに空で返す (span は残るので、飛ばしたことは追える)。
    if (!purchaseOrder || purchaseOrder.lines.length === 0 || specSheets.length === 0) {
      // ⚠ **飛ばしたときも「済」を流す。** 流さないと画面が回り続ける。
      await emitProgress(writer, { ...node, stage: "shape", status: "succeeded" });
      return { ...response, extraction: { ...response.extraction, links: [] } };
    }

    const request = getInitData<DocExtractRequest>();
    const run = await runExtraction({
      modelId: resolveModelId(request.requestContext?.model),
      instructions: promptFor("link", response.extraction.formCode),
      label: "対応づけ",
      schema: linkAnswer,
      // ⚠ 紙は見ない。読み取った印字だけを突き合わせる。
      images: [],
      requireImages: false,
      instruction: [
        "次の明細と依頼書の対応づけを答えてください。",
        linkView(purchaseOrder, specSheets),
      ].join("\n\n"),
      tracingContext,
      mastra,
    });

    /*
     * ⚠⚠ **モデルが作った番号を通さない。** 実在しない `lineNo` や `specSheetIndex` を
     *   返す実行があると、web 側で添字がずれて**関係のない依頼書が明細に付く**。
     *   ここで落とすほうが、空のまま進めるより安全。
     */
    const lineNos = new Set(purchaseOrder.lines.map((line) => line.lineNo));
    const links = run.extraction.links.filter(
      (link) =>
        lineNos.has(link.lineNo) &&
        (link.specSheetIndex === null || link.specSheetIndex < specSheets.length),
    );

    await emitProgress(writer, { ...node, stage: "shape", status: "succeeded" });

    return {
      ...response,
      extraction: { ...response.extraction, links },
      // ⚠ 費用は足す (このノードのぶんも 1 通の読み取りの費用)。⚠ 時間は実時間のまま。
      inputTokens: addTokens(response.inputTokens, run.inputTokens),
      outputTokens: addTokens(response.outputTokens, run.outputTokens),
      // ⚠ 生出力は**ノードごとに分けて**残す。⚠⚠ **1 本目は分類のまま** (順番を入れ替えない)。
      rawOutput: appendRawOutputs(response.rawOutput, [run.rawOutput]),
    };
  },
});
