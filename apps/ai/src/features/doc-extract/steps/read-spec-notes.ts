import { createStep } from "@mastra/core/workflows";
import {
  docExtractResponseSchema,
  specNoteAnswer,
  type DocExtractRequest,
  type DocExtractResponse,
} from "../contract";
import { mapWithLimit, SPEC_SHEET_CONCURRENCY } from "../lib/concurrency";
import { addTokens, appendRawOutputs } from "../lib/node-runs";
import { EXTRACT_DPI, imagesForPages, type DetailCrop } from "../lib/page-images";
import { noteNodeLabel } from "../lib/progress";
import { pageLabels, runExtraction } from "../lib/run-extraction";
import { promptFor } from "../prompts";
import { resolveModelId } from "../../../shared/models";

export const readSpecNotesStepId = "read-spec-notes";

/**
 * このノードに渡す横帯の本数。**`steps/extract.ts` と同じ 6。**
 *
 * ⚠ メモは紙の**いちばん下**に小さな活字で並ぶので、ページ全体の 1 枚だけでは
 *   読める画素が足りない (`steps/extract.ts` の `ZOOM_BANDS` の表)。
 */
const NOTE_ZOOM_BANDS = 6;

/**
 * ★ 帯に加えて渡す、**紙の下の余白を横にも割って細かく拡大した** 2 枚。
 *
 * ⚠⚠ **なぜ要るか。** メモには日本語・タイ語・英数字が 1 つの語の中で混ざる。小さなタイ文字は
 *   帯 6 本では画素が足りず、指示文を直しても別のタイ文字に読み違えた (実測 3 回で完全一致 1 回)。
 *   帯を増やしても幅で縮小の上限に当たるので (`page-images.ts` の `DetailCrop`)、**横にも割る**。
 *   実測: 指示文 + この拡大で 3 回とも完全一致。
 * ⚠ **高さは紙の下 12 %。** サンプルのメモ 5 行は下 7 % ほどに収まっている。行が増えて
 *   はみ出しても、帯とページ全体で見えるので落ちはしない (細かく見えないだけ)。
 * ⚠ **左右を 20 % 重ねる。** 境目に載った文字がどちらかで切れずに見えるように。
 *   メモは左に寄って印字されているが、長い行が右へはみ出しても右の 1 枚で見える。
 */
const NOTE_DETAILS: readonly DetailCrop[] = [
  { top: 0.88, bottom: 1, left: 0, right: 0.6, label: "紙のいちばん下の左側" },
  { top: 0.88, bottom: 1, left: 0.4, right: 1, label: "紙のいちばん下の右側" },
];

/**
 * ノード⑤: 依頼書 1 枚ごとに **下部のメモ** (`ラベル : 値`) だけを読む。
 *
 * ⚠⚠ **将来は消す機能。** 消し方は `contract.ts` の `specNoteFields` の注記。
 *   workflow から `.then(readSpecNotesStep)` を外し、このファイルと `prompts/spec-note.ts` を消す。
 * ⚠⚠ **欄の読み取り (`steps/extract.ts`) とは別の呼び出し。** 足すと区分が再び落ちうる
 *   (実測)。形は `steps/locate-pictures.ts` と同じ。
 * ⚠⚠ **`tracingContext` と `mastra` を受け取ること。** 渡さないと、この step の下の
 *   モデル呼び出しの span が**丸ごと消える** (`lib/run-extraction.ts` の冒頭)。例外も出ない。
 * ⚠ **agent は登録しない。** `instructions` / `model` は**値で渡す**。
 */
export const readSpecNotesStep = createStep({
  id: readSpecNotesStepId,
  description: "依頼書 1 枚ごとに下部のメモだけを読む",
  inputSchema: docExtractResponseSchema,
  outputSchema: docExtractResponseSchema,
  execute: async ({ inputData, getInitData, tracingContext, mastra }) => {
    const response: DocExtractResponse = inputData;
    // ⚠ PDF は step の入出力に載せず、workflow の入力から読む (`classify.ts` の注記)。
    const request = getInitData<DocExtractRequest>();
    const startedAt = Date.now();

    const sheets = response.extraction.specSheets;
    /*
     * ⚠⚠ **`steps/extract.ts` と同じ絞り方・同じ並び**にする。ここがずれると、
     *   メモを**別の依頼書に**埋め戻してしまう。
     */
    const parts = response.classification.parts
      .filter((part) => part.role === "spec_sheet")
      .slice(0, sheets.length);
    // ⚠ 依頼書が 0 枚ならモデルを呼ばない。
    if (parts.length === 0) return response;

    const modelId = resolveModelId(request.requestContext?.model);
    const instructions = promptFor("spec_note", response.extraction.formCode);

    const runs = await mapWithLimit(parts, SPEC_SHEET_CONCURRENCY, async (part, index) => {
      /*
       * ⚠⚠ **進捗は流さない。** 画面に「下部のメモ (依頼書 n 枚目)」を出さないことにした
       *   (`lib/progress.ts` の `extractNodesOf()` も載せていない)。呼び名は失敗の名指しにだけ使う。
       */
      const label = noteNodeLabel(index);
      try {
        const images = await imagesForPages(
          request,
          part.pages,
          EXTRACT_DPI,
          NOTE_ZOOM_BANDS,
          NOTE_DETAILS,
        );
        const run = await runExtraction({
          modelId,
          instructions,
          label,
          schema: specNoteAnswer,
          images,
          instruction: [
            `この依頼書のいちばん下にあるメモだけを読んでください。ファイル名: ${request.filename}`,
            pageLabels(images),
          ]
            .filter(Boolean)
            .join("\n"),
          tracingContext,
          mastra,
        });
        return run;
      } catch (error) {
        // ⚠⚠ **どの枚で落ちたかを名前に残す。** 並列なので、素の例外では何枚目か分からない。
        const where = `${label} (${part.pages.join(" ・ ")} ページ目)`;
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
          specNote: runs[index]?.extraction ?? null,
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
      // ⚠⚠ **合計ではなく実時間。** この step が始まってから終わるまでを足す。
      latencyMs: response.latencyMs + (Date.now() - startedAt),
      // ⚠⚠ **1 本目は分類のまま** (順番を入れ替えない)。
      rawOutput: appendRawOutputs(
        response.rawOutput,
        runs.map((run) => run.rawOutput),
      ),
    };
  },
});
