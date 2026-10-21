import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { classificationAnswer, documentClassification, docExtractRequestSchema } from "../contract";
import { partsFromPages } from "../lib/group-parts";
import { emitProgress, extractNodesOf } from "../lib/progress";
import { CLASSIFY_DPI, imagesForPages } from "../lib/page-images";
import { countPages } from "../lib/pdf-pages";
import { pageLabels, runExtraction } from "../lib/run-extraction";
import { formNameOf, promptFor } from "../prompts";
import { resolveModelId } from "../../../shared/models";

export const classifyStepId = "classify";

/**
 * ノード①の出力。**次のノード (読み取り) の入力でもある。**
 *
 * ⚠⚠ **PDF (`request`) を持ち越さない。** 以前はここに `request` を丸ごと入れていたが、
 *   step の入出力は**トレースにも workflow の snapshot にも載る**ので、
 *   1 実行のあいだに PDF の base64 が何度も書かれていた (実測で 1 実行 7.4MB)。
 *   要るノードは `getInitData()` で workflow の入力から読む。
 */
export const classifyStepOutput = z.object({
  classification: documentClassification,
  promptId: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  latencyMs: z.number(),
  rawOutput: z.string(),
});

/**
 * ノード①: この PDF が**どの様式**で、**どのページがどの部品**かを決める。
 *
 * ⚠⚠ **ここで値は読まない。** 読み取りは次のノード。分けてあるのは
 *   「依頼書が何枚あるか」を**コードが知っている状態**を作るため
 *   (1 回で全部読ませると、落とした枚数に誰も気づけない)。
 * ⚠ **全ページを、低い解像度で渡す。** 表題と見出しと紙の形しか見ないので
 *   `CLASSIFY_DPI` (100) で足りる。ここを上げても分類は良くならず、入力だけが増える。
 * ⚠ **「発注書か依頼書か」をページごとに仕分ける仕事ではない。** 実物は
 *   「発注書 1 通 + 依頼書 n 枚」で 1 通の帳票の束なので、**様式は束に 1 つ**。
 */
export const classifyStep = createStep({
  id: classifyStepId,
  description: "1 通の PDF の様式を 1 つ選び、どのページがどの部品かを決める",
  inputSchema: docExtractRequestSchema,
  outputSchema: classifyStepOutput,
  execute: async ({ inputData, tracingContext, mastra, writer }) => {
    const request = inputData;
    await emitProgress(writer, {
      node: classifyStepId,
      label: "発注書フォーマットを分類",
      stage: "classify",
      status: "running",
    });
    // ⚠ 指示文の正は `prompts/`(= git)。モデルは束全体の指定 → 既定の順。
    const instructions = promptFor("classify", null);
    const modelId = resolveModelId(request.requestContext?.model);

    // ⚠ 分類は**束の全体**を見ないと部品の構成が決まらないので、全ページを渡す。
    const pageCount = countPages(Buffer.from(request.dataBase64, "base64"));
    if (pageCount === 0) throw new Error("PDF のページを数えられませんでした");
    const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
    const images = await imagesForPages(request, pages, CLASSIFY_DPI);

    const run = await runExtraction({
      modelId,
      instructions,
      label: "分類",
      // ⚠⚠ **モデルに答えさせるのはここまで** (`parts` と `formName` は下でコードが作る)。
      schema: classificationAnswer,
      images,
      instruction: [
        `この帳票の束の様式を 1 つ選び、**ページ 1 枚ずつ**が何の紙かを答えてください。ファイル名: ${request.filename}`,
        pageLabels(images),
      ].join("\n\n"),
      // ⚠⚠ **観測はここでしか繋がらない。** `tracingContext.currentSpan` はこの step の
      //   `workflow_step` span で、渡さないとモデル呼び出しの span が丸ごと消える
      //   (`lib/run-extraction.ts` の冒頭)。
      tracingContext,
      mastra,
    });

    /*
     * ★★ **読み取りの回数はここで決まる。** モデルに数えさせず、
     *   ページの並びと「新しい 1 枚の始まりか」からコードが組み立てる
     *   (`lib/group-parts.ts` の冒頭)。
     */
    const classification = {
      ...run.extraction,
      // ⚠ 名前はモデルに答えさせない (正は `prompts/index.ts` の表)。
      formName: formNameOf(run.extraction.formCode),
      parts: partsFromPages(run.extraction.pages),
    };

    const parsed = documentClassification.parse(classification);

    await emitProgress(writer, {
      node: classifyStepId,
      label: "発注書フォーマットを分類",
      stage: "classify",
      status: "succeeded",
    });
    /*
     * ★★ **これから走るノードを、走る前に流す。**
     *   枚数が決まるのはここ (`partsFromPages`) だけなので、ここで流さないと
     *   画面は「依頼書 3 枚目 (待機)」を出せず、**終わった順に生えてくる**ように見える。
     */
    for (const node of extractNodesOf(parsed.parts)) {
      await emitProgress(writer, { ...node, stage: "extract", status: "pending" });
    }

    return {
      classification: parsed,
      // ⚠ 指示文は DB ではなくファイル (git) にあるので、指す ID は無い。
      promptId: null,
      model: run.model,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      latencyMs: run.latencyMs,
      rawOutput: run.rawOutput,
    };
  },
});
