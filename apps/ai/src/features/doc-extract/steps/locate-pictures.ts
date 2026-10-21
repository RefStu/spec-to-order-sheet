import { createStep } from "@mastra/core/workflows";
import {
  docExtractResponseSchema,
  pictureLocationAnswer,
  type DocExtractRequest,
  type DocExtractResponse,
} from "../contract";
import { mapWithLimit, SPEC_SHEET_CONCURRENCY } from "../lib/concurrency";
import { addTokens, appendRawOutputs } from "../lib/node-runs";
import { EXTRACT_DPI, imagesForPages } from "../lib/page-images";
import { emitProgress, pictureNodeKey, pictureNodeLabel } from "../lib/progress";
import { pageLabels, runExtraction } from "../lib/run-extraction";
import { promptFor } from "../prompts";
import { resolveModelId } from "../../../shared/models";

export const locatePicturesStepId = "locate-pictures";

/**
 * ★★ このノードに渡す横帯の本数。**`steps/extract.ts` と同じ 6。**
 *
 * ⚠⚠ **0 にしない。実測で枠が 3 倍に太った**:
 *
 *   | 帯 | 依頼書1 の面積 | 依頼書2 の面積 | 実物 |
 *   |----|---------------:|---------------:|-----:|
 *   | 6  |         0.0048 |         0.0080 | 0.005 |
 *   | 0  |         0.0192 |         0.0144 | 0.005 |
 *
 *   ページ全体の 1 枚だけでは、**図の端がどこで終わるかを決められる画素が無い**。
 *   帯を渡すと紙の下半分が拡大されて届くので、枠が図 1 つぶんに締まる。
 * ⚠ **「帯だと帯基準の y を返すのでは」という懸念は実測で否定された。**
 *   帯を渡していた版の枠は**ページ基準のまま**正しく収まっていた
 *   (`pageLabels()` が「同じページの一部を拡大したもの」と毎回言っているため)。
 *   ⚠ そのうえで文面は「割合は**ページ全体の画像**に対するもの」と言い切っている
 *   (`prompts/picture-location.ts`)。**この 1 行を消さないこと。**
 */
const PICTURE_ZOOM_BANDS = 6;

/**
 * ノード④: 依頼書 1 枚ごとに **代表の図の図の場所だけ**を聞く。
 *
 * ⚠⚠ **欄の読み取りと分けたのは実測から。** specNo・品位・品名・区分と図の座標を
 *   同じ呼び出しで聞いていたころ、実行ごとにどれかが落ちていた。
 *   1 回のモデル呼び出しに詰め込むほど、どれかが薄くなる。
 * ⚠⚠ **読み取りの回数を決めるのはコード。** 分類が組み立てた `parts` の数だけ走る。
 *   モデルに枚数を数えさせない。
 * ⚠⚠ **`tracingContext` と `mastra` を受け取ること。** 渡さないと、この step の下の
 *   モデル呼び出しの span が**丸ごと消える** (`lib/run-extraction.ts` の冒頭)。例外も出ない。
 * ⚠ **agent は登録しない。** `runExtraction` が呼び出しごとに使い捨ての `Agent` を組む。
 *   `instructions` / `model` は**値で渡す** (関数や requestContext 越しに戻すと、
 *   並列にした瞬間に「最後に書いたノードのモデル」が全ノードに効く罠が戻る)。
 */
export const locatePicturesStep = createStep({
  id: locatePicturesStepId,
  description: "依頼書 1 枚ごとに代表の図の図の場所だけを聞く",
  inputSchema: docExtractResponseSchema,
  outputSchema: docExtractResponseSchema,
  execute: async ({ inputData, getInitData, tracingContext, mastra, writer }) => {
    const response: DocExtractResponse = inputData;
    // ⚠ PDF は step の入出力に載せず、workflow の入力から読む (`classify.ts` の注記)。
    const request = getInitData<DocExtractRequest>();
    const startedAt = Date.now();

    const sheets = response.extraction.specSheets;
    /*
     * ⚠⚠ **`steps/extract.ts` と同じ絞り方・同じ並び**にする。ここがずれると、
     *   枠を**別の依頼書に**埋め戻してしまう (`specSheetIndex` は添字で指しているため)。
     * ⚠ 読み取りが落ちた枚のぶんは `specSheets` に無いので、`slice` で合わせる。
     */
    const parts = response.classification.parts
      .filter((part) => part.role === "spec_sheet")
      .slice(0, sheets.length);
    // ⚠ 依頼書が 0 枚ならモデルを呼ばない (進捗も流れない。分類が pending を出していない)。
    if (parts.length === 0) return response;

    const modelId = resolveModelId(request.requestContext?.model);
    const instructions = promptFor("picture_location", response.extraction.formCode);

    const runs = await mapWithLimit(parts, SPEC_SHEET_CONCURRENCY, async (part, index) => {
      // ⚠ 鍵は `lib/progress.ts` の `extractNodesOf()` と同じ (`pic-n`)。
      //   ずれると、分類が流した「待機」が終わらないまま残る。
      const node = { node: pictureNodeKey(index), label: pictureNodeLabel(index) };
      await emitProgress(writer, { ...node, stage: "extract", status: "running" });
      try {
        const images = await imagesForPages(request, part.pages, EXTRACT_DPI, PICTURE_ZOOM_BANDS);
        const run = await runExtraction({
          modelId,
          instructions,
          label: node.label,
          schema: pictureLocationAnswer,
          images,
          instruction: [
            `この依頼書に並んでいる図のうち、いちばん左上にある 1 つがどこにあるかだけを答えてください。ファイル名: ${request.filename}`,
            pageLabels(images),
          ]
            .filter(Boolean)
            .join("\n"),
          tracingContext,
          mastra,
        });
        await emitProgress(writer, { ...node, stage: "extract", status: "succeeded" });
        return run;
      } catch (error) {
        // ⚠ **失敗も流してから投げ直す。** 流さないと画面が回り続ける。
        await emitProgress(writer, { ...node, stage: "extract", status: "failed" });
        // ⚠⚠ **どの枚で落ちたかを名前に残す。** 並列なので、素の例外では何枚目か分からない。
        const where = `${node.label} (${part.pages.join(" ・ ")} ページ目)`;
        throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    });

    return {
      ...response,
      extraction: {
        ...response.extraction,
        // ⚠ **添字で当てる** (`parts` の並び = `specSheets` の並び)。
        specSheets: sheets.map((sheet, index) => ({
          ...sheet,
          pictures: runs[index]?.extraction.pictures ?? [],
        })),
      },
      // ⚠ 費用は足す (このノードのぶんも 1 通の読み取りの費用)。
      inputTokens: runs.reduce<number | null>(
        (acc, run) => addTokens(acc, run.inputTokens),
        response.inputTokens,
      ),
      outputTokens: runs.reduce<number | null>(
        (acc, run) => addTokens(acc, run.outputTokens),
        response.outputTokens,
      ),
      // ⚠⚠ **合計ではなく実時間。** 中は並列なので、ノードの latency を足すと
      //   実際にかかった時間を超える。この step が始まってから終わるまでを足す。
      latencyMs: response.latencyMs + (Date.now() - startedAt),
      // ⚠ 生出力は**ノードごとに分けて**残す。⚠⚠ **1 本目は分類のまま** (順番を入れ替えない)。
      rawOutput: appendRawOutputs(
        response.rawOutput,
        runs.map((run) => run.rawOutput),
      ),
    };
  },
});
