import type {
  DocExtractProgressEvent,
  DocExtractResponse,
  docExtractPath,
  docExtractStreamPath,
} from "@repo/ai/contracts/doc-extract";
import { z } from "zod";

/**
 * ai (Cloud Run) の読み取り API の形を web 側に写したもの。
 *
 * ⚠ **web は ai を `import type` でしか読めない**(境界ルール ④)。値は使えないので、
 *   パスも zod も web 側に書き、**型で突き合わせる**。ai 側で変わったら型検査で落ちる。
 * ⚠ **キューを通って戻ってくる値も、HTTP で返る値も信用しない。** ここで検証する。
 * ⚠⚠ **入口は 1 本だけ。** 実物は 1 つの PDF に発注書と依頼書が内包されて届くので、
 *   ai 側が「分類 → 読み取り」の workflow でまとめて返す。
 */
export const DOC_EXTRACT_PATH = "/v1/doc-extract/document" satisfies typeof docExtractPath;

/**
 * ★★ 進捗つきの読み取り (NDJSON)。**consumer はこちらを使う。**
 *
 * ⚠ `DOC_EXTRACT_PATH` (1 回の JSON 応答) は**戻り道として残してある**。
 *   stream が通らなくなったら consumer の宛先をそちらへ戻せば動く。
 */
export const DOC_EXTRACT_STREAM_PATH =
  "/v1/doc-extract/document/stream" satisfies typeof docExtractStreamPath;

const extractedField = z.object({
  value: z.union([z.string(), z.number()]).nullable(),
  quote: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  confidence: z.number().int().min(0).max(100),
});

/**
 * 代表の図の枠。
 * ⚠ **数の範囲を縛らない。** ai 側と同じ理由 (外れ値で読み取りごと落とさない)。
 *   使ってよいかは ai 側の `usableBox` が既に判断していて、web には
 *   **切り出せたものだけ**が届く。
 */
const pictureBox = z.object({
  page: z.number().int(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  confidence: z.number().int().min(0).max(100),
  /**
   * その図を選ぶのに使ったラベルの語。
   * ⚠⚠ **これで足切りはしない** (ai 側と同じ判断)。当たり外れを後から測るための根拠。
   * ⚠ 既定値の理由は下の `pictures` と同じ (ai と web は別々にデプロイされる)。
   */
  labelQuote: z.string().nullable().default(null),
});

const meta = {
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  rawOutput: z.string(),
};

const purchaseOrderExtraction = z.object({
  header: z.object({
    // ⚠ 取引先の名前は読ませない (帳票上の会社名と取引先の対応が一意でないため)。
    customerPoNo: extractedField,
    // ⚠ **発注日は ai が読まなくなった**。列 (`purchase_orders.ordered_on`) は
    //   残してあるが、AI は埋めない。⚠ `satisfies z.ZodType<DocExtractResponse>` が
    //   ai 側と食い違ったら型検査で落とす。
  }),
  lines: z.array(
    z.object({
      lineNo: z.number().int().positive(),
      modelNo: extractedField,
      productName: extractedField,
      sizeText: extractedField,
      quantity: extractedField,
      // ⚠ shipDate は読まない (人が埋める欄)。ai の contract.ts を参照。
      remarkText: extractedField,
    }),
  ),
});

/**
 * ★ 依頼書の**下部に印字したメモ** (**将来は消す**)。ai の `specNoteFields` の写し。
 * ⚠ 値は印字そのまま。どのセルに入れるかは `order-sheet-generator.ts` の `fillFromSpecNote()`。
 */
const specNoteFields = z.object({
  sizeText: extractedField,
  stoneText: extractedField,
  description2: extractedField,
  description3: extractedField,
  description4: extractedField,
});

/** ⚠ **1 通の PDF に明細の数だけ入る。** 単数ではない。 */
const specSheetExtraction = z.object({
  specNo: extractedField,
  productName: extractedField,
  purityText: extractedField,
  requestCategoryText: extractedField,
  /**
   * ★★ 区分の行に並んでいる語と、**それぞれに手書きの丸が重なっているか**。
   * ⚠ 既に読み終わったジョブの記録には無いので `.default([])`。
   */
  // ⚠ **語ごとの marked は ai が返さなくなった**。区分は
  //   `requestCategoryText` の 1 語だけで決める (`chooseRequestCategory`)。
  /**
   * 代表の図の**枠**。**1 枚の依頼書に複数載ることがある。**
   *
   * ⚠ 切り出した**画像**のほうは `extraction.pictures` (別物)。
   * ⚠⚠ **ai 側は必須、ここだけ `.default([])`。** ai (Cloud Run) と web (Workers) は
   *   別々に出るので、古い ai の応答をここで**丸ごと parse 失敗**させると
   *   **ジョブ全体が落ちる**。既定値は意味の上でも正しい (枠が無い = 空)。
   */
  pictures: z.array(pictureBox).default([]),
  /**
   * 下部のメモ。null = ai のノードが走っていない。
   * ⚠⚠ **ai 側は必須、ここだけ `.default(null)`。** 理由は上の `pictures` と同じ
   *   (古い ai の応答や、読み終わったジョブの記録で**ジョブ全体を落とさない**)。
   */
  specNote: specNoteFields.nullable().default(null),
});

/** 切り出せた代表の図。**どの依頼書のものかは `specSheets` の添字で指す。** */
const extractedPicture = z.object({
  specSheetIndex: z.number().int().nonnegative(),
  /**
   * その依頼書の何枚目の図か (0 から)。**R2 の鍵がこれで決まる** (`photoStorageKey`)。
   * ⚠ 既定の 0 は「1 枚だけ = 従来の鍵」。古い ai の応答でもそのまま正しい。
   */
  pictureIndex: z.number().int().nonnegative().default(0),
  dataBase64: z.string().min(1),
  mediaType: z.string().min(1),
  box: pictureBox,
});

/**
 * 分類ノードの答え。**様式は 1 通の PDF に 1 つ**で、その中に部品が n 個ある。
 *
 * ⚠ 部品の `role` に `mixed` は無い。`mixed` は**様式**の性質 (発注書と依頼書が同居する)
 *   であって、ページの役割ではない。web は読めた中身から `po_documents.doc_kind` を決める
 *   (`purchase-orders/services/document-writer.ts`)。
 */
const documentClassification = z.object({
  /** ⚠ ai が持つ様式の一覧 (ai の `prompts/index.ts`) の符号。web の表とは別物。 */
  formCode: z.string().nullable(),
  /** ⚠ 名前は ai がその表から引いたもの (モデルの答えではない)。 */
  formName: z.string().nullable(),
  formConfidence: z.number().int().min(0).max(100),
  /**
   * ★ ページ 1 枚ずつの種類。**分類が外れたときに人が気づける唯一の手がかり**
   *   (`headerQuote` = その紙の表題の印字そのまま)。
   * ⚠ `ai_extraction_payloads.raw_output` の 1 本目と合わせて読む。
   */
  pages: z.array(
    z.object({
      page: z.number().int().positive(),
      docType: z.enum(["purchase_order", "spec_sheet", "other"]),
      headerQuote: z.string().nullable(),
      startsNewSheet: z.boolean(),
      confidence: z.number().int().min(0).max(100),
    }),
  ),
  /** ⚠⚠ **読み取りが何回走ったか**。ai 側はコードが組み立てている (モデルの答えではない)。 */
  parts: z.array(
    z.object({
      role: z.enum(["purchase_order", "spec_sheet", "unknown"]),
      pages: z.array(z.number().int().positive()).min(1),
      confidence: z.number().int().min(0).max(100),
    }),
  ),
});

/**
 * ★ 発注書の明細と依頼書の対応づけ (ai の最終ノード)。
 *
 * ⚠⚠ **正ではない。** 突き合わせの正は web 側の `order-sheets/lib/spec-no.ts` の
 *   `matchBySpecNo()` (決定的)。ここは**規則で結べなかった明細の受け皿**として使う。
 *   結果は `order_sheet_lines.revision_request_id` に**書き込まれる**ので、
 *   実行ごとに揺れるものを正にすると**同じ帳票から違う ORDER SHEET が出る**。
 * ⚠ `.default([])` … 既に読み終わったジョブの記録には無いため。
 */
export const extractionLink = z.object({
  lineNo: z.number().int().positive(),
  specSheetIndex: z.number().int().nonnegative().nullable(),
  /** ⚠ `z.enum` にしてあるのは ai 側と同じ閉じた集合だから。増やすときは両方。 */
  matchedBy: z.enum(["spec_no", "product_name", "other"]).nullable(),
  confidence: z.number().int().min(0).max(100),
});
export type ExtractionLink = z.infer<typeof extractionLink>;

export const docExtractResponse = z.object({
  ...meta,
  extraction: z.object({
    formCode: z.string().nullable(),
    purchaseOrder: purchaseOrderExtraction.nullable(),
    specSheets: z.array(specSheetExtraction),
    pictures: z.array(extractedPicture),
    links: z.array(extractionLink).default([]),
  }),
  classification: documentClassification,
  // ⚠⚠ **`promptIds` はもう来ない。** 指示文は ai のファイル (git) が正になった。
  //   `ai_jobs.prompt_id` は `ai_prompts.id` への外部キーなので、符号のような文字列を
  //   入れ直さないこと (insert ごと落ちる)。
}) satisfies z.ZodType<DocExtractResponse>;

export type DocExtractResult = z.infer<typeof docExtractResponse>;
export type ExtractedPurchaseOrder = z.infer<typeof purchaseOrderExtraction>;
export type ExtractedSpecSheet = z.infer<typeof specSheetExtraction>;
export type ExtractedSpecNote = z.infer<typeof specNoteFields>;
export type ExtractedPicture = z.infer<typeof extractedPicture>;

/**
 * ★★ 進捗の 1 件。**ai が 1 行 1 JSON で流してくる。**
 *
 * ⚠⚠ **`stage` と `status` を `z.string()` にしない。** 画面が段を縦に並べる順を
 *   この閉じた集合で決めているので、知らない値が来たら**捨てる**ほうが正しい
 *   (知らない段を描こうとして順が崩れるより、出ないほうがよい)。
 *   ⚠ ai が段を増やしたらここにも足す (型検査では落ちない)。
 * ⚠ `node` は鍵、`label` は表示用。**鍵で畳む** (語で畳むと語を変えたとき増える)。
 */
export const docExtractProgressEvent = z.object({
  type: z.literal("progress"),
  node: z.string(),
  label: z.string(),
  stage: z.enum(["classify", "extract", "shape"]),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  at: z.number().int().nonnegative(),
}) satisfies z.ZodType<DocExtractProgressEvent>;
export type DocExtractProgress = z.infer<typeof docExtractProgressEvent>;

/**
 * NDJSON の 1 行。**最後の 1 行が `result` か `error`。**
 *
 * ⚠⚠ **結果の行が来ないまま切れたら失敗として扱う** (`consumer.ts`)。
 *   途中で切れた stream を成功にすると、**読めていない帳票が succeeded で畳まれる**。
 */
export const docExtractStreamLine = z.discriminatedUnion("type", [
  docExtractProgressEvent,
  z.object({ type: z.literal("result"), result: docExtractResponse }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
export type DocExtractStreamLine = z.infer<typeof docExtractStreamLine>;
