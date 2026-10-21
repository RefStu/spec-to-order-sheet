import type { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import type { TracingContext } from "@mastra/core/observability";
import type { z } from "zod";
import type { ExtractionImage } from "./page-images";

/**
 * ★★ **1 回のモデル呼び出し**。workflow の各ノードの共通部分。
 *
 * ⚠⚠ **登録された agent は使わない。** 流れは workflow の step が持ち、ここは
 *   「**この指示文とこのモデルで 1 回聞く**」だけ。`mastra.getAgentById` で共有の agent を
 *   引くのをやめ、**呼び出しごとに使い捨ての Agent を組み立てる**。
 * ⚠⚠ **これでモデルと指示文が「引数」になった。** 共有の agent 越しだったころは
 *   `requestContext` に入れて `generate` の時点で遅延して読ませていたため、
 *   **並列に読むと最後に書いたノードのモデルが全ノードに効く**という罠があった。
 *   引数なら構造的に起きない。⚠ requestContext 越しに戻さないこと。
 * ⚠⚠ **`ai` の `generateText` を直接呼ばないこと。実測で壊れた。**
 *   この版の AI SDK は file part を `{ type: "data", data }` の形で渡すが、Mastra の
 *   `ModelRouterLanguageModel` は **LanguageModelV2** として実装されていて、その先の
 *   provider は `convertToBase64()` が Uint8Array 以外を**素通し**する。結果、画像が
 *   `[object Object]` として送られ、プロバイダが
 *   「Expected a base64-encoded data URL ... but got an invalid base64-encoded value」で
 *   500 を返す。**この版の組み合わせでは画像を渡せない。**
 *   → 画像の受け渡しは Mastra (Agent) に任せる。**Mastra を上げたときに再挑戦してよい。**
 *   ⚠ そのときは `ai` を `apps/ai/package.json` の依存に入れること。`mastra build` は
 *   bare import を `.mastra/output/package.json` に書き出してそこで install し、
 *   **コンテナの image は `.mastra/output` しか持っていかない**ので、依存に無いと
 *   **ビルドした image でだけ「Cannot find package 'ai'」で起動しない** (ローカルでも再現した)。
 */

/** `runExtraction` が返すもの。`ai_jobs` の記録 (費用・時間・モデル) に使う。 */
export interface ExtractionRun<T> {
  extraction: T;
  /** 実際に使われたモデル。`ai_jobs.model_name` に入れる (分からなければ null)。 */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  rawOutput: string;
}

/** 応答から実際のモデル名を拾う (プロバイダによって欠ける)。 */
function modelIdOf(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const modelId = (response as { modelId?: unknown }).modelId;
  return typeof modelId === "string" && modelId.length > 0 ? modelId : null;
}

/** number でなければ null にする (usage はモデルによって欠ける)。 */
function toCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * 添付した画像が**元の PDF の何ページ目か**を伝える。
 *
 * ⚠⚠ **これは必須。** 契約の `page` は「PDF 全体の通し番号」のままなので、
 *   これを言わないとモデルは**全部 1 ページ目だと答える** (渡された画像しか見えないため)。
 *   `ai_extraction_fields.page_no` が原本へ戻る唯一の手がかりなので、ここが崩れると辿れなくなる。
 * ⚠ 以前の `pagesHint()` (「n ページ目だけ読んで」と**言葉で**頼む) の置き換え。
 *   いまは**要るページの画像しか渡していない**ので、読む範囲を言葉で縛る必要が無い。
 */
export function pageLabels(images: readonly ExtractionImage[]): string {
  if (images.length === 0) return "";
  const pages = [...new Set(images.map((image) => image.pageNo))];
  const zoomed = images.filter((image) => image.zoomed).length;

  const lines = [
    `添付した画像は、元の PDF の ${pages.join(" ・ ")} ページ目です (画像の並びがこの順に対応します)。`,
    `page の欄には必ずこの通し番号を入れてください。`,
  ];
  if (zoomed > 0) {
    /*
     * ⚠⚠ **二重に数えさせない。** 拡大した帯はページ全体と同じ紙なので、
     *   これを言わないと表の行や明細が**2 回**出てくる。
     */
    lines.push(
      `⚠ ページ全体の画像のあとに、**同じページの一部を拡大した画像**が ${zoomed} 枚続きます。`,
      `拡大した画像は細かい印字を読むためのもので、**別の紙ではありません**。`,
      `同じ行や同じ明細を**二重に数えないでください**。`,
    );
    /*
     * ⚠⚠ **帯がページのどこかを言う。** 言わないと、モデルは並びから位置を推測するしかなく、
     *   「表題のすぐ下の行」を探しても**紙の中ほどの別の行**を読んでしまう (実測)。
     */
    const bands = images.filter((image) => image.band !== null);
    if (bands.length > 0) {
      const total = bands[0]!.band!.total;
      lines.push(
        `拡大した画像は**ページを上から ${total} 本の横帯に割ったもの**で、` +
          `渡した順に ${bands.map((image) => `${image.band!.index} 本目`).join(" → ")} です` +
          `(帯どうしは少し重なっています)。`,
        `紙の**上のほう**を見たいときは先頭の帯を、**下のほう**を見たいときは最後の帯を見てください。`,
      );
    }
    /*
     * ⚠⚠ **細部の拡大も場所を言う**。帯と同じで、言わないと位置を推測できない。
     *   帯の本数には数えない (`band` が null)。
     */
    const details = images.filter((image) => image.detail !== undefined);
    if (details.length > 0) {
      lines.push(
        `さらに最後の ${details.length} 枚は、紙の一部だけを**もっと細かく拡大した画像**です` +
          ` (${details.map((image) => image.detail).join(" → ")})。` +
          `小さな文字はこちらで確かめてください。これも**同じページの一部**です。`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * 1 回読んで、決めた形の JSON にする。
 *
 * ⚠⚠ **渡すのは PDF ではなく、そのノードが読むページの画像**
 *   (`lib/page-images.ts`。理由はそのファイルの冒頭)。**1 ページ = 1 つの file part。**
 * ⚠ 画像は AI SDK の file part として渡す。`fetchAi` が JSON しか送れないので、
 *   web からは base64 で届く。
 */
export async function runExtraction<T>(options: {
  /** `"openai/gpt-5"` のような文字列。`shared/models.ts` が一覧と突き合わせて決める。 */
  modelId: string;
  /** そのノードの指示文 (画面から保存された版があればそちら)。 */
  instructions: string;
  schema: z.ZodType<T>;
  /** そのノードが読むページの画像。**空で呼ばない** (何も見ずに答えさせない)。 */
  images: readonly ExtractionImage[];
  /**
   * 画像を必ず渡すか。**既定は真**。
   *
   * ⚠⚠ **偽にしてよいのは「紙を見ないノード」だけ** (読み取った文字だけを見て答えるもの)。
   *   帳票を読むノードで偽にすると、**指示文だけを見てでっち上げる**。
   */
  requireImages?: boolean;
  /** 読む範囲やファイル名など、そのノードだけの前置き。 */
  instruction: string;
  /** 落ちたときに名指しできる名前 (「依頼書 2 枚目」など)。 */
  label: string;
  /**
   * ⚠⚠ **観測はこの 2 つでしか繋がらない。** step の `execute` が受け取ったものを素通しする。
   *
   *   `@mastra/core` の `getOrCreateSpan()` は分岐が 2 本しかない。
   *   ① `tracingContext.currentSpan` があれば、その**子 span** を作る
   *   ② 無ければ `mastra.observability` から**新しい root span** を作る
   *   **どちらも無ければ `undefined` を返して span を作らない。`?.` の連鎖なので例外も出ない。**
   *   ⚠ ここを渡し忘れると、`agent_run` も `model_generation` も**丸ごと消える**
   *   (workflow の span だけが残り、中身が空のまま伸びる)。実際に起きた。
   *   ⚠ `tracingOptions` (traceId) は ② の中でしか使われない。登録していない Agent に
   *   渡しても**完全に無意味**。トレースの根は `run.start()` 側で決める。
   */
  tracingContext?: TracingContext;
  /** 同上 (②の保険)。使い捨ての Agent は登録されていないので、自動では注入されない。 */
  mastra?: Mastra;
}): Promise<ExtractionRun<T>> {
  const {
    modelId,
    instructions,
    schema,
    images,
    instruction,
    label,
    requireImages = true,
    tracingContext,
    mastra,
  } = options;

  // ⚠ 1 枚も無いまま呼ぶと、モデルは指示文だけを見て**でっち上げる**。名指しで落とす。
  if (requireImages && images.length === 0) {
    throw new Error(`読み取るページの画像がありません (${label})`);
  }

  /*
   * ⚠ **使い捨ての Agent。** 登録 (`mastra.getAgentById`) はしない。
   *   ⚠⚠ **`instructions` と `model` は値で渡す** (関数にして requestContext から読ませない)。
   *   ここを関数に戻すと、並列に走らせたときに取り違える形が戻る。
   *   ⚠ memory は持たせない。1 枚読むごとに独立していてほしい
   *   (前の依頼書の値が混ざるとでっち上げの元になる)。
   */
  const agent = new Agent({
    id: `doc-extract:${label}`,
    name: label,
    instructions,
    model: modelId,
    tools: {},
    // ⚠ 登録していない Agent は `#mastra` が undefined になり、観測が丸ごと効かなくなる。
    ...(mastra ? { mastra } : {}),
  });

  const startedAt = Date.now();
  const result = await agent.generate(
    [
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          // ⚠ **並びが `pageLabels()` の並びと一致していること。** ここがずれると
          //   モデルが返す page が原本のページとずれる。
          ...images.map((image) => ({
            type: "file" as const,
            data: image.dataBase64,
            mediaType: image.mediaType,
          })),
        ],
      },
    ],
    // ⚠ `tracingContext` を渡すと、この呼び出しの span が **その step の span の子**になる。
    { structuredOutput: { schema }, ...(tracingContext ? { tracingContext } : {}) },
  );
  const latencyMs = Date.now() - startedAt;

  if (result.error) throw new Error(`読み取りに失敗しました (${label}): ${result.error}`);

  // 形を外すことがあるので、**黙って空の結果にせず**、ジョブを failed に落とす。
  const parsed = schema.safeParse(result.object);
  if (!parsed.success) {
    throw new Error(`読み取り結果が決めた形と違います (${label}): ${parsed.error.message}`);
  }

  return {
    extraction: parsed.data,
    // ⚠ resolveModelId で引き直さない。**実際に使われたモデル**を応答から取る。
    model: modelIdOf(result.response),
    inputTokens: toCount(result.totalUsage?.inputTokens),
    outputTokens: toCount(result.totalUsage?.outputTokens),
    latencyMs,
    // ⚠ プロンプトを変えて読み直したときに比べられるよう、生出力をそのまま残す。
    rawOutput: result.text ? result.text : JSON.stringify(result.object),
  };
}
