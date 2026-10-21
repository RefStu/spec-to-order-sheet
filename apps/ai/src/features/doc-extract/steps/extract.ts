import { createStep } from "@mastra/core/workflows";
import type { z } from "zod";
import {
  docExtractResponseSchema,
  purchaseOrderExtraction,
  specSheetFieldsAnswer,
  type DocExtractRequest,
  type SpecSheetExtraction,
} from "../contract";
import { mapWithLimit, SPEC_SHEET_CONCURRENCY } from "../lib/concurrency";
import { addTokens, type NodeRun } from "../lib/node-runs";
import { EXTRACT_DPI, imagesForPages } from "../lib/page-images";
import { emitProgress, specSheetLabel } from "../lib/progress";
import { pageLabels, runExtraction } from "../lib/run-extraction";
import { promptFor } from "../prompts";
import { resolveModelId } from "../../../shared/models";
import { classifyStepOutput } from "./classify";

/**
 * ★★ ページを**横帯に割って拡大した画像**を何枚足すか。
 *
 * ⚠⚠ **dpi を上げても効かない。** 200 dpi と 300 dpi で入力トークンが **15,504 でまったく
 *   同じ**だった ＝ プロバイダ側が画像を一定の大きさまで縮める。A4 を 1 枚まるごと渡す
 *   かぎり、**紙の細部に使える画素は増えない。**
 * ⚠⚠ **効くのは「帯を細くすること」。** 帯の高さが下がると短辺が短くなり、縮小率が上がる。
 *   実測 (サンプル 1 通 / gpt-5):
 *
 *   | 帯 | 資材名           | 区分 (丸印)      | 入力tok | 出力tok | 秒 |
 *   |----|------------------|------------------|--------:|--------:|---:|
 *   | 0  | 読めない         | 読めない         |  15,504 |  12,194 | 63 |
 *   | 2  | ほぼ読める       | 読めない         |  21,046 |  14,628 | 71 |
 *   | 3  | 読める           | 読めない         |  25,392 |  11,378 | 59 |
 *   | 6  | 読める           | **読める**       |  34,422 |   9,485 | 51 |
 *
 *   入力は 2.2 倍になるが、**出力が 22 % 減って時間も縮む** (当てずっぽうが減るため)。
 *   gpt-5 は出力のほうが桁違いに高いので、**費用はほぼ変わらない。**
 * ⚠ **上げる前に必ず実測で効果を確かめること。** 闇雲に増やすと入力だけが増える。
 * ⚠ 0 にすると全体の 1 枚だけに戻る (`steps/locate-pictures.ts` はそうしている)。
 *
 * ⚠⚠ **この表は gpt-5 で測った。既定のモデルは gpt-5-mini** (`ai_jobs.model_name`)。
 *   REMARK の欠けは**帯が足りない証拠ではない**: `XX 0001` / `XX 0002` を
 *   **confidence 90 で両方読めた実行**があり、同じ帯・同じ紙で後の 2 実行が null だった
 *   ＝ **run 間のばらつき**。
 *   ⚠⚠ **だからここを 6 から上げないこと。** 帯 6 で既にページの**幅**がプロバイダ側の
 *   上限に当たっていて、上げても渡る画素は増えず
 *   入力だけが増える。⚠ 上げるなら **gpt-5-mini で測り直してこの表に行を足してから**。
 */
const ZOOM_BANDS = 6;

export const extractStepId = "extract";

/**
 * ノード②③: 仕分けた結果にしたがって**コードが決めた回数だけ**読む。
 *
 * ⚠⚠ **発注書は 1 回、依頼書は枚数ぶん。** 回数を決めるのは分類の結果であって
 *   モデルの判断ではない。ここが「決定的な処理」の本体。
 * ⚠⚠ **発注書と依頼書は同時に走らせる。** 依頼書は発注書の結果を使っていないので独立。
 *   依頼書の n 枚も互いに独立なので、`SPEC_SHEET_CONCURRENCY` を上限に並べて走らせる。
 *   直列だと明細が増えるだけ時間が伸びる (実測 2 明細で 160 秒)。
 * ⚠⚠ **どの枚で落ちたかが分かることを壊さない。** 結果は**添字で埋める**(push しない)、
 *   失敗は「依頼書 k 枚目 (p ページ)」と名指しでまとめて投げる。
 * ⚠⚠ **ノードごとに requestContext を分ける** (`nodeContext`)。共有のものを書き換える形の
 *   まま並列にすると、モデルの指定が**最後に書いたノードのもの**に揃ってしまう。
 * ⚠⚠ **その部品のページの画像だけを渡す。** 以前は 4 回とも PDF 全体を送り、
 *   「n ページ目だけ読んで」と言葉で頼んでいた。隣のページが見えていたせいで
 *   **1 枚目の石を 2 枚目に写すでっち上げ**が実際に起きた。**見せないほうが確実。**
 * ⚠ `unknown` と分類されたページは読まない (読めないものを読んだふりにしない)。
 */
export const extractStep = createStep({
  id: extractStepId,
  description: "仕分けた結果にしたがって発注書を 1 回、依頼書を枚数ぶん読む",
  inputSchema: classifyStepOutput,
  // ⚠⚠ **PDF を持ち越さない。** 次のノード (切り出し) も `getInitData()` で読む
  //   (step の入出力はトレースにも snapshot にも載るため — `classify.ts` の注記)。
  outputSchema: docExtractResponseSchema,
  // ⚠⚠ **`tracingContext` と `mastra` を受け取ること。** 渡さないと、この step の下の
  //   モデル呼び出しの span が丸ごと消える (`lib/run-extraction.ts` の冒頭)。
  //   ⚠ 下は `Promise.all` で並列に走るが、**引数で明示的に渡す**ので取り違えは起きない
  //   (ALS のような暗黙の受け渡しに頼らない)。
  execute: async ({ inputData, getInitData, tracingContext, mastra, writer }) => {
    // ⚠ PDF は step の入出力に載せず、workflow の入力から読む (`classify.ts` の注記)。
    //   ⚠ ここで zod の parse を掛けない (毎ノードで base64 を検証することになる)。
    const request = getInitData<DocExtractRequest>();
    const { classification } = inputData;
    const startedAt = Date.now();
    // ⚠⚠ **1 本目は分類。** `rawOutput` の 1 本目が分類の生出力であることに人が頼っている
    //   (分類が「依頼書 0 枚」と外したときに気づける唯一の場所)。**順番を入れ替えないこと。**
    const runs: NodeRun[] = [
      {
        model: inputData.model,
        inputTokens: inputData.inputTokens,
        outputTokens: inputData.outputTokens,
        latencyMs: inputData.latencyMs,
        rawOutput: inputData.rawOutput,
      },
    ];

    const purchaseOrders = classification.parts.filter((p) => p.role === "purchase_order");
    const specSheets = classification.parts.filter((p) => p.role === "spec_sheet");

    // ── 発注書 ────────────────────────────────────────────────────────────
    // ⚠ 複数あっても 1 通目だけを読む。**1 案件 = ORDER SHEET 1 枚**で、
    //   2 通目以降は別の帳票として投入する形にしてある (複数通の扱いは決めていないため)。
    const poPart = purchaseOrders[0];
    /*
     * ⚠⚠ **指示文とモデルは値で渡す** (関数や requestContext 越しにしない)。
     *   共有のものを `generate` の時点で読ませていたころは、**並列にした瞬間に
     *   「最後に書いたノードのモデル」が全ノードに効く**という罠があった。
     * ★ 様式が決まったので、ここで初めて**様式ごとの指示文**を引ける
     *   (分類より前には決まらない)。
     */
    const modelId = resolveModelId(request.requestContext?.model);
    const poInstructions = promptFor("purchase_order", classification.formCode);

    const readPurchaseOrder = async () => {
      if (!poPart) return null;
      /*
       * ⚠ 進捗の鍵は `lib/progress.ts` の `extractNodesOf()` と**同じ**にする
       *   (`po` / `spec-n`)。ずれると、分類が流した「待機」が終わらないまま残る。
       */
      await emitProgress(writer, {
        node: "po",
        label: "発注書",
        stage: "extract",
        status: "running",
      });
      try {
        // ⚠ 資材名などの細かい印字はページ全体では読めない (実測)。帯を足して拡大する。
        const images = await imagesForPages(request, poPart.pages, EXTRACT_DPI, ZOOM_BANDS);
        const run = await runExtraction({
          modelId,
          instructions: poInstructions,
          label: "発注書",
          schema: purchaseOrderExtraction,
          images,
          instruction: [
            `発注書を読み取ってください。ファイル名: ${request.filename}`,
            pageLabels(images),
          ]
            .filter(Boolean)
            .join("\n"),
          tracingContext,
          mastra,
        });
        await emitProgress(writer, {
          node: "po",
          label: "発注書",
          stage: "extract",
          status: "succeeded",
        });
        return run;
      } catch (error) {
        // ⚠ **失敗も流してから投げ直す。** 流さないと画面が回り続ける。
        await emitProgress(writer, {
          node: "po",
          label: "発注書",
          stage: "extract",
          status: "failed",
        });
        throw error;
      }
    };

    // ── 依頼書 (枚数ぶん) ─────────────────────────────────────────────────
    const sheetInstructions = promptFor("spec_sheet", classification.formCode);

    const readSpecSheets = () =>
      specSheets.length > 0
        ? mapWithLimit(specSheets, SPEC_SHEET_CONCURRENCY, async (sheet, index) => {
            /*
             * ⚠⚠ **同時に走っているノードがそのまま見えるのが狙い。**
             *   `SPEC_SHEET_CONCURRENCY` を超えたぶんは `pending` のまま残る — それが正しい。
             * ⚠ 鍵は `lib/progress.ts` の `extractNodesOf()` と同じ `spec-n` (1 始まり)。
             */
            const node = { node: `spec-${index + 1}`, label: specSheetLabel(index) };
            await emitProgress(writer, { ...node, stage: "extract", status: "running" });
            try {
              // ⚠ 区分の丸印はページ全体では読めない (実測)。帯を足して拡大する。
              const images = await imagesForPages(request, sheet.pages, EXTRACT_DPI, ZOOM_BANDS);
              const run = await runExtraction({
                modelId,
                instructions: sheetInstructions,
                // ⚠⚠ **どの枚で落ちたかを名前に残す。** 並列なので、素の例外では何枚目か分からない。
                label: node.label,
                schema: specSheetFieldsAnswer,
                images,
                instruction: [
                  `依頼書を 1 枚読み取ってください。ファイル名: ${request.filename}`,
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
              // ⚠⚠ **どの枚で落ちたかを名前に残す。** 並列にすると、素の例外だけでは
              //   何枚目が壊れたのか分からなくなる (直列のときは順番で分かっていた)。
              const where = `${node.label} (${sheet.pages.join(" ・ ")} ページ目)`;
              throw new Error(
                `${where}: ${error instanceof Error ? error.message : String(error)}`,
                {
                  cause: error,
                },
              );
            }
          })
        : Promise.resolve([]);

    // ⚠ 発注書と依頼書は独立 (依頼書は発注書の結果を使っていない)。同時に走らせる。
    const [poRun, sheetRuns] = await Promise.all([readPurchaseOrder(), readSpecSheets()]);

    const purchaseOrder: z.infer<typeof purchaseOrderExtraction> | null = poRun
      ? poRun.extraction
      : null;
    // ⚠ **枠は次のノード (`steps/locate-pictures.ts`) が入れる。ここでは必ず空。**
    //   このノードの schema (`specSheetFieldsAnswer`) は `pictures` を聞いていない。
    // ⚠ 下部のメモも次のノード (`steps/read-spec-notes.ts`) が入れる。ここでは null。
    const sheets: SpecSheetExtraction[] = sheetRuns.map((run) => ({
      ...run.extraction,
      pictures: [],
      specNote: null,
    }));
    // ⚠⚠ **runs の 1 本目は分類のまま。** rawOutput の 1 本目が分類の生出力であることに
    //   人が頼っている (分類が外したときに気づける唯一の場所)。**順番を入れ替えないこと。**
    if (poRun) runs.push(poRun);
    runs.push(...sheetRuns);

    return {
      extraction: {
        // ⚠ 様式は分類が **1 つだけ**選ぶ (部品ごとに違う様式を名乗らない)。
        formCode: classification.formCode,
        purchaseOrder,
        specSheets: sheets,
        // ⚠ 切り出した写真も対応づけも次のノードが入れる。ここでは必ず空で出す。
        pictures: [],
        links: [],
      },
      classification,
      // ⚠ 費用と時間は**全ノードの合計**。1 通の読み取りにいくらかかったかを見たいので。
      model: runs.find((r) => r.model !== null)?.model ?? null,
      inputTokens: runs.reduce<number | null>((acc, r) => addTokens(acc, r.inputTokens), null),
      outputTokens: runs.reduce<number | null>((acc, r) => addTokens(acc, r.outputTokens), null),
      // ⚠⚠ **合計ではなく実時間。** 並列に読むので、ノードの latency を足すと
      //   実際にかかった時間を超える (「250 秒で終わったのに 400 秒」と記録される)。
      //   知りたいのは「1 通の読み取りが何秒かかったか」なので、
      //   分類 (直列) + このノード (壁時計) にする。
      //   ⚠ トークンのほうは**合計のまま**でよい (費用は足し算で増える)。
      latencyMs: inputData.latencyMs + (Date.now() - startedAt),
      // ⚠ 生出力は**ノードごとに分けて**残す (どのノードが崩れたか分かるように)。
      //   ⚠⚠ **1 本目が分類ノードの生出力。** 分類が外したとき
      //   (「依頼書 0 枚」と答えたときなど) に人が気づける場所はここと Langfuse の
      //   トレースだけなので、**順番を入れ替えないこと**。
      rawOutput: JSON.stringify(runs.map((r) => r.rawOutput)),
    };
  },
});
