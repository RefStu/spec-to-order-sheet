import { z } from "zod";
import { modelIdSchema, type ModelId } from "../../shared/model-ids";

/**
 * 選べるモデルの一覧の型。**web はこれを `import type` で読み、自分の写しを
 * `satisfies readonly ModelId[]` で突き合わせる** (値は境界ルールで import できない)。
 */
export type { ModelId };

/**
 * 帳票 (発注書・新製品依頼書) の読み取りの web ↔ ai の入出力。
 * web は型だけを使う: `import type { … } from "@repo/ai/contracts/doc-extract"`
 *
 * ⚠⚠ **実物は 1 つの PDF に発注書と新製品依頼書が内包されて届く。**
 *   しかも依頼書は**明細の数だけ**入っている。だから読み取りは
 *   **「分類 → 読み取り」の 2 段の workflow** になっていて、
 *   入口はこの 1 本だけ (`docExtractPath`)。
 * ⚠ Mastra の独自ルートは "/api" で始められない (server の apiPrefix と衝突する)。
 */
export const docExtractPath = "/v1/doc-extract/document";

/**
 * ★★ **進捗つきの読み取り** (NDJSON。1 行 1 JSON)。
 *
 * ⚠⚠ **`docExtractPath` (1 回の JSON 応答) は残してある。** こちらが通らないときの
 *   戻り道で、`run.start()` のまま動く。**消さないこと。**
 * ⚠ 流すのは**自分の進捗と、最後の 1 行の結果だけ**。モデルのチャンクは流さない
 *   (span に巨大な base64 を載せないのと同じ理由で、受け手が詰まる)。
 * ⚠ これを読むのは web の Queue consumer であってブラウザではない。
 *   consumer が 1 行ずつ `ai_jobs.progress_json` に書き、**画面はそれをポーリングする**。
 */
export const docExtractStreamPath = "/v1/doc-extract/document/stream";

export const documentExtractWorkflowId = "document-extract";

// ⚠ **agent の id はもう無い。** 読み取りは workflow の step が直接モデルを呼ぶので、
//   登録するのは workflow 1 つだけ (`feature.ts`)。

// ⚠⚠ **指示文の受け渡しはもう無い。** 様式ごとの指示文を web(D1) から渡す仕組みは
//   やめて、**`prompts/` のファイル (= git) が正**になった。
//   役割の語彙が要るときは `prompts/index.ts` の `PromptRole` を見ること。

/**
 * 読み取った 1 欄。**すべての欄がこの形で返る。**
 *
 * ⚠ `quote` は **原本の印字そのまま**。`value` は正規化した後 (日付は YYYY-MM-DD、数量は数値)。
 *   2 つに分けてあるのは、AI の欄のうち Code master / Size / CUSTOMER PO・NO は
 *   **印字そのままが ORDER SHEET に入る値**だから。加えて、`quote` がページの文字に
 *   見つからなければ **でっち上げをその場で検出できる**。
 * ⚠ `confidence` は **0..100 の整数** (`ai_extraction_fields.confidence` に合わせてある)。
 *   画面の契約 (order-sheets/schema.ts) は 0..1 なので、web 側で割る。
 * ⚠ bbox は返させない。座標はモデルが推測するだけで当てにならないため、辿れるのは
 *   `page` まで。
 * ⚠⚠ `page` は **PDF 全体の通し番号**。帳票ごとに 1 に戻さない
 *   (`ai_extraction_fields.page_no` が原本へ戻る唯一の手がかり)。
 */
export const extractedField = z.object({
  /** 印字が無い欄は **null**。埋めない (でっち上げ防止)。 */
  value: z.union([z.string(), z.number()]).nullable(),
  quote: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  confidence: z.number().int().min(0).max(100),
});
export type ExtractedField = z.infer<typeof extractedField>;

/**
 * 代表の図の図が載っている場所。
 *
 * ⚠⚠ **数の範囲をここで縛らない。** モデルが 0..1 を外した値を返したときに
 *   `safeParse` が落ちると**読み取りごと失敗する**。範囲の検査は
 *   `lib/picture-box.ts` の `usableBox()` が受け取ってから行い、外れたら**切らない**。
 */
export const pictureBox = z.object({
  /** PDF 全体の通し番号。 */
  page: z.number().int(),
  /** ページの幅・高さを 1 とした割合。x / y は図を囲む四角の左上。 */
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  confidence: z.number().int().min(0).max(100),
  /**
   * ★ その図を選ぶのに使った**ラベルの語**(印字そのまま)。語が見えなければ null。
   *
   * ⚠⚠ **これで足切りはしない。** `MIN_BOX_CONFIDENCE = 0` と同じ判断で、
   *   ここを見て枠を捨てる処理は**書かない** (`lib/picture-box.ts` は読まない)。
   *   当たり外れを**後から測る**ための根拠として残すだけ (当たりを上げる手は閾値ではない)。
   */
  labelQuote: z.string().nullable(),
});
export type PictureBox = z.infer<typeof pictureBox>;

/**
 * 様式の中の**部品**の役割。
 *
 * ⚠⚠ **「帳票の種類」ではなく「部品」。** 実物は「発注書 1 通 + 依頼書 n 枚」が
 *   1 通の PDF で届く**ひとつの様式**で、依頼書は別の帳票ではなく**発注書に添えられた部品**。
 * ⚠ 分からないものを名乗らせない (`unknown` を残す)。
 * ⚠ 値は `PromptRole` / `ai_prompts.purpose` と語彙を揃えてある (改名するときは両方)。
 */
export const documentPartRoleSchema = z.enum(["purchase_order", "spec_sheet", "unknown"]);
export type DocumentPartRole = z.infer<typeof documentPartRoleSchema>;

/**
 * ページ 1 枚の種類。**「部品」ではなく「その紙が何か」。**
 *
 * ⚠ `parts` の `role` (部品の役割) と値を揃えてあるが、意味が違う。
 *   こちらは**紙 1 枚**、あちらは**読み取り 1 回の単位**。
 */
export const pageDocTypeSchema = z.enum(["purchase_order", "spec_sheet", "other"]);
export type PageDocType = z.infer<typeof pageDocTypeSchema>;

/** ページ 1 枚ぶんの分類。**モデルが答えるのはここまで。** */
export const classifiedPage = z.object({
  /** PDF 全体の通し番号 (1 始まり)。 */
  page: z.number().int().positive(),
  docType: pageDocTypeSchema,
  /**
   * そう判断した根拠 = そのページの**いちばん上に印字された表題**そのまま。
   *
   * ⚠⚠ **分類が外れたときに人が気づける唯一の手がかり。** 値を読ませない分類ノードで、
   *   「何を見てそう決めたか」を残せる欄はここだけ。読めなければ null (でっち上げない)。
   */
  headerQuote: z.string().nullable(),
  /**
   * ⚠⚠ **このページが「新しい 1 枚の 1 ページ目」か。**
   *   依頼書が 2 ページにまたがる様式で**枚数が狂わない**ための境界。
   *   `docType` が `spec_sheet` 以外のときは見ない。
   * ⚠ **`.default(true)` にしない (必須のまま)。** 省ける形にすると、モデルが
   *   **欄ごと返さない**実行が出る (区分の欄で実測した罠と同じ)。
   */
  startsNewSheet: z.boolean(),
  confidence: z.number().int().min(0).max(100),
});
export type ClassifiedPage = z.infer<typeof classifiedPage>;

/**
 * ★★ 分類のノードに**モデルが答える**ぶん。
 *
 * ⚠⚠ **`parts` を答えさせない。** 読み取りの回数は `parts.length` で決まるのに、
 *   数えるのをモデルに任せると、**2 枚を 1 要素にまとめた実行で読み取りが 1 回しか
 *   走らず、誰も気づけない**。境界の判断 (`startsNewSheet`) だけを聞き、
 *   **数えるのはコード** (`lib/group-parts.ts`) にする。
 *   流れはコードが持つ。分類が「2 枚」と言えば読み取りは必ず 2 回。
 */
export const classificationAnswer = z.object({
  /**
   * ai が持つ様式の一覧 (`prompts/index.ts` の表) から 1 つ。当てはまらなければ null。
   * ⚠ 一覧に無い code を作らせない (プロンプトで縛り、`knownFormCode()` で受け止める)。
   */
  formCode: z.string().nullable(),
  /** 様式を選んだことにどれくらい自信があるか。 */
  formConfidence: z.number().int().min(0).max(100),
  /** ⚠ `.min(1)` を付けてよい (画像を 1 枚以上渡しているので、0 ページはありえない)。 */
  pages: z.array(classifiedPage).min(1),
});
export type ClassificationAnswer = z.infer<typeof classificationAnswer>;

/**
 * ノード①(分類)の出力。**どの様式か + ページごとの種類 + 読み取りの単位。**
 *
 * ⚠⚠ **様式は 1 通の PDF に 1 つ。** 部品ごとに別の様式を名乗らせない。
 * ⚠ `parts` に `.min(1)` は付けない。**「1 つも分からなかった」を表せる形**にしておく
 *   (無理に 1 つ作らせると、読み取りが空振りしたことに誰も気づけない)。
 */
export const documentClassification = classificationAnswer.extend({
  /**
   * 様式の呼び名。
   * ⚠ **モデルには答えさせない。** 名前の正を 1 か所に保つため、`formCode` から引く。
   */
  formName: z.string().nullable(),
  /** ⚠⚠ **コードが `pages` から組み立てる** (`lib/group-parts.ts`)。モデルの答えではない。 */
  parts: z.array(
    z.object({
      role: documentPartRoleSchema,
      /** その部品が載っているページ (PDF 全体の通し番号。1 始まり)。 */
      pages: z.array(z.number().int().positive()).min(1),
      confidence: z.number().int().min(0).max(100),
    }),
  ),
});
export type DocumentClassification = z.infer<typeof documentClassification>;

/** 発注書。取り出すのは ORDER SHEET に出る欄 + 製造番号。 */
export const purchaseOrderExtraction = z.object({
  header: z.object({
    /**
     * CUSTOMER PO / NO 欄。お客様側の**発注No**。
     * ⚠ **取引先の名前は読ませない。** 実物には差出人・納入場所・受付窓口が別々に印字されて
     *   いて、どれが CUSTOMER になるかが決まっていない。
     *   **別の会社名を自信たっぷりに入れるのが一番悪い**ので、取らない。
     */
    customerPoNo: extractedField,
    /*
     * ⚠⚠ **発注日 (`orderedOn`) は読まない**。
     *   `purchase_orders.ordered_on` → `order_sheets.issued_on` に入るだけで、
     *   **ORDER SHEET のどのセルにも出ない** (DATE は出力した日の日付)。
     *   使われない値のためにモデルの注意を割かない。⚠ D1 の列は残してある
     *   (帳票の日付が要るようになったら、ここに足し直すところから)。
     */
  }),
  lines: z.array(
    z.object({
      lineNo: z.number().int().positive(),
      /**
       * 製造番号。**3 帳票を繋ぐ鍵** (= 依頼書の番号 `specNo` = ORDER SHEET の Code master 1 段目)。
       * ⚠ 発注書は年を 2 桁で印字することがある。**印字そのままでよい**
       *   (桁を合わせるのは web 側の `specNoKeys()` の仕事)。
       */
      modelNo: extractedField,
      /** **資材名** (Description 欄のもと。**製造番号が無い明細ではこれが突き合わせの鍵**)。 */
      productName: extractedField,
      /** Size 欄。号数も長さもここ。印字そのまま。 */
      sizeText: extractedField,
      /** QTY 欄 (本数)。数値。 */
      quantity: extractedField,
      /*
       * ⚠⚠ **明細の Ship date は読まない (人が埋める欄)。**
       *   実物には「印字された納期」「手書きの出荷日」「手書きの渡し日」が別々にあり、
       *   実物の ORDER SHEET の SHIP DATE は**そのどれとも一致しなかった** (工程表の最終日と同じ)。
       *   **出どころが決まっていない欄を AI に埋めさせない**。
       *   ⚠ これで**手書きを読む欄が 1 つも無くなった**。COMMON の第 1 条に例外は無い。
       *   ⚠ 列 (`purchase_order_lines.requested_ship_date` / `order_sheet_lines.ship_date`) は残る。
       *   ⚠ ヘッダの SHIP (`order_sheets.ship_date`) は元から人の欄。**別物なので混ぜない。**
       */
      /** REMARK 欄。**オーダーNo の下**に印字されている整理の記号。 */
      remarkText: extractedField,
    }),
  ),
});
export type PurchaseOrderExtraction = z.infer<typeof purchaseOrderExtraction>;

/**
 * ★ 依頼書の**下部に印字したメモ** (`ラベル : 値` を 1 行ずつ) から読むもの。
 *
 * ⚠⚠ **将来は消す機能**。目的は「AI が紙から本当に値を読めている」ことの証明。
 *   消すときに触るのは 4 か所だけ:
 *   ① `steps/read-spec-notes.ts` + `prompts/spec-note.ts` (専用のノード)
 *   ② このまとまり (`specNoteFields` と `specSheetExtraction.specNote`)
 *   ③ web の `revision_request_specs.note_*` の列 (migration を 1 本足す)
 *   ④ web の `order-sheet-generator.ts` の `fillFromSpecNote()`
 * ⚠ 値は**印字そのまま** (正規化しない)。ORDER SHEET のセルへそのまま載せるため。
 * ⚠⚠ **`.optional()` / `.default()` にしない (必須のまま)。** 省ける形にすると、モデルが
 *   **欄ごと返さない**実行が出る (区分の欄で実測した罠と同じ)。無ければ各欄が null。
 */
export const specNoteFields = z.object({
  /** `Size` の行。ORDER SHEET の Size (`H16`)。⚠ **発注書のサイズが空の明細だけ**に使う。 */
  sizeText: extractedField,
  /** `STONE` の行。STONE (`G16`)。 */
  stoneText: extractedField,
  /** `Description#2` の行。POLISH (`F17`)。 */
  description2: extractedField,
  /** `Description#3` の行。メッキ (`F18`)。 */
  description3: extractedField,
  /** `Description#4` の行。ロゴ (`F20`)。⚠ `F19` は空のまま。 */
  description4: extractedField,
});
export type SpecNoteFields = z.infer<typeof specNoteFields>;

/**
 * 新製品依頼書 **1 枚ぶん**。
 *
 * ⚠⚠ **1 通の PDF に明細の数だけ入る。** 1 枚 = 1 要素。
 * ⚠ 完成重量の内訳や希望原価は原紙に印字されているが ORDER SHEET に出ないので読まない。
 */
export const specSheetExtraction = z.object({
  /** 依頼書の番号 = 発注書の製造番号。**年は印字どおり (4 桁のことが多い)。** */
  specNo: extractedField,
  /** 品名。**製造番号が印字されていない明細と結ぶための予備の鍵。** */
  productName: extractedField,
  /** 品位 (SV950 など)。ORDER SHEET の Description に入る。 */
  purityText: extractedField,
  /**
   * 表題のすぐ下で**選ばれている**区分 (印字そのまま)。**印が 1 つに絞れたときだけ**入る。
   * ⚠ ORDER SHEET の Description の頭に付く語を決めるのに使う。
   *   **語の対応はここに書かない** (web 側の閉じた集合が持つ)。
   */
  requestCategoryText: extractedField,
  /*
   * ⚠⚠ **`requestCategoryChoices` (語ごとの marked) はやめた。**
   *   実測 3 回とも `requestCategoryText` だけで **2 枚とも**「鋳造」が取れ
   *   (confidence 85〜90)、web の受け皿②(marked が 1 つなら採る) は一度も出番が無かった。
   *   ⚠ **戻すなら、まず「①だけでは足りなかった」実測を取ること。**
   *     以前の形は git の履歴にある。
   */

  /**
   * 代表の図の図の場所。**1 枚の依頼書に複数載ることがある。**
   *
   * ⚠ ここは**枠**(モデルが答えた座標)。切り出した**画像**のほうは
   *   `documentExtraction.pictures` (別物。名前が似ているので混ぜないこと)。
   * ⚠⚠ **`.default([])` にしない (必須のまま)。** 省ける形にすると、モデルが
   *   **欄ごと返さない**実行が出る (区分の欄で実測した罠と同じ)。
   *   1 つも見つからなければ**空の配列**を返させる。
   */
  pictures: z.array(pictureBox),
  /**
   * ★ 下部のメモ (**将来は消す**)。埋めるのは `steps/read-spec-notes.ts`。
   * ⚠ null = **このノードが走っていない** (欄の読み取りの直後など)。
   *   走ってメモが無かったときは、null ではなく**各欄が null** のまとまりになる。
   */
  specNote: specNoteFields.nullable(),
});
export type SpecSheetExtraction = z.infer<typeof specSheetExtraction>;

/**
 * ★★ 依頼書のノードに**モデルが答える**ぶん。**公開の契約から `pictures` を外したもの。**
 *
 * ⚠⚠ **`specSheetExtraction` のほうは変えない。** web の写しは `pictures` を読むので、
 *   外すのは「**1 回の呼び出しで何を聞くか**」だけ。枠を埋めるのは `steps/locate-pictures.ts`。
 * ⚠⚠ **分けた理由は実測。** specNo・品位・品名・区分と**図の座標**を同じ呼び出しで
 *   聞いていたころ、区分と REMARK が実行ごとに落ちていた。
 *   1 回のモデル呼び出しに詰め込むほど、どれかが薄くなる。
 * ⚠ 前例は `classificationAnswer` (モデルの答えだけを表す schema)。
 */
export const specSheetFieldsAnswer = specSheetExtraction.omit({
  pictures: true,
  // ⚠⚠ 下部のメモも**ここでは聞かない**。欄の読み取りに足すと、区分が再び落ちうる
  //   (実測: ノードの荷物を降ろしたら区分が取れた)。
  specNote: true,
});
export type SpecSheetFieldsAnswer = z.infer<typeof specSheetFieldsAnswer>;

/**
 * ★★ 代表の図の場所のノードに**モデルが答える**ぶん。**座標だけ。**
 *
 * ⚠⚠ **`.default([])` にしない (必須のまま)。** 省ける形にすると、モデルが
 *   **欄ごと返さない**実行が出る (区分の欄で実測した罠と同じ)。
 *   1 つも見つからなければ**空の配列**を返させる。
 */
export const pictureLocationAnswer = z.object({ pictures: z.array(pictureBox) });
export type PictureLocationAnswer = z.infer<typeof pictureLocationAnswer>;

/**
 * ★ 下部のメモのノードに**モデルが答える**ぶん (**将来は消す**)。
 * ⚠ 前例は `pictureLocationAnswer` (モデルの答えだけを表す schema)。
 */
export const specNoteAnswer = specNoteFields;
export type SpecNoteAnswer = z.infer<typeof specNoteAnswer>;

/**
 * 切り出した代表の図 1 枚。
 *
 * ⚠ **どの依頼書のものかは `specSheets` の添字で指す。** `specNo` で指すと、
 *   番号が読めなかった依頼書の写真が迷子になる。
 */
export const extractedPicture = z.object({
  specSheetIndex: z.number().int().nonnegative(),
  /**
   * その依頼書の**何枚目**の図か (0 から)。`specSheets[].pictures` の並びで決まる。
   *
   * ⚠⚠ **web の R2 の鍵がこの番号から決まる** (`photoStorageKey`)。切れなかった枠の
   *   ぶんは**番号が飛ぶ**が、それでよい。切れたものに 0 から振り直すと、前の実行と
   *   同じ図が違う鍵になり、同じバイト列の `files` 行が増える。
   */
  pictureIndex: z.number().int().nonnegative(),
  /** 画像の base64 (data URL の接頭辞は付けない)。 */
  dataBase64: z.string().min(1),
  mediaType: z.string().min(1),
  /**
   * **実際に切った枠**。モデルの枠を図 1 つに寄せたもの (`lib/snap-box.ts`)。
   * ⚠ モデルが答えたままの枠は `specSheets[].pictures` に残っている (寄せる前後を比べられる)。
   */
  box: pictureBox,
});
export type ExtractedPicture = z.infer<typeof extractedPicture>;

/**
 * ★ 発注書の明細 1 行と、それに対応する依頼書。
 *
 * ⚠⚠ **突き合わせの「正」ではない。** 番号の正規化 (全角・区切り・年の桁) の規則は
 *   web 側の `order-sheets/lib/spec-no.ts` が持っていて、**決定的**に動く。
 *   ここは「**規則では結べなかったものを、人が目で見るように結ぶ**」ぶんだけを足す材料。
 *   ⚠ ai に正規化の規則を書き写さないこと (その日から 2 つがずれていく)。
 */
export const specSheetLink = z.object({
  /** 発注書の明細 (`purchaseOrder.lines[].lineNo`)。 */
  lineNo: z.number().int().positive(),
  /** 結びついた依頼書 (`specSheets` の添字)。結べなければ null。 */
  specSheetIndex: z.number().int().nonnegative().nullable(),
  /** 何を見て結んだか。結べなければ null。 */
  matchedBy: z.enum(["spec_no", "product_name", "other"]).nullable(),
  confidence: z.number().int().min(0).max(100),
});
export type SpecSheetLink = z.infer<typeof specSheetLink>;

/** workflow 全体の出力。**片方しか入っていない PDF でも同じ形で返る。** */
export const documentExtraction = z.object({
  /** 分類が一覧から選べたときだけ入る。選べなければ null。 */
  formCode: z.string().nullable(),
  /** 発注書が入っていなければ **null**。 */
  purchaseOrder: purchaseOrderExtraction.nullable(),
  /** 依頼書が入っていなければ **空の配列**。 */
  specSheets: z.array(specSheetExtraction),
  /** 切り出せた代表の図。**切れなかったものは入らない** (空が正常)。 */
  pictures: z.array(extractedPicture),
  /**
   * 明細と依頼書の対応づけ。**ORDER SHEET は組み立てない** (組み立ては web)。
   * ⚠ 発注書が無い / 依頼書が 0 枚なら空の配列 (モデルも呼ばない)。
   */
  links: z.array(specSheetLink),
});
export type DocumentExtraction = z.infer<typeof documentExtraction>;

/**
 * Langfuse などの観測をまとめるための指定。
 * ⚠ Mastra は **traceparent ヘッダを自動では拾わない**ので、明示的に渡す
 *   (`@mastra/core` の `TracingOptions`)。
 */
export const tracingOptionsSchema = z.object({
  /** 1..32 桁の 16 進。W3C の trace id と同じ形にしてある。 */
  traceId: z.string().regex(/^[0-9a-f]{1,32}$/),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  tags: z.array(z.string()).optional(),
});
export type DocExtractTracingOptions = z.infer<typeof tracingOptionsSchema>;

/**
 * 読み取りの要求。**PDF は base64 で JSON に埋める。**
 * (`apps/web/src/shared/ai/ai-client.ts` の `fetchAi` は content-type が
 *  application/json 固定で、multipart もバイナリも送れない)
 */
export const docExtractRequestSchema = z.object({
  /** `ai_jobs.id`。workflow の runId に使うので、retry は同じ run を再開する。 */
  jobId: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  dataBase64: z.string().min(1),
  /*
   * ⚠⚠ **様式の候補も指示文も受け取らない。** どちらも `prompts/` のファイルが正
   *   (様式も欄も固まっていないうちは早すぎると判断した)。
   *   戻すときは `formProfiles` / `prompts` をここに足し直すところから。
   */
  requestContext: z.object({ model: modelIdSchema.optional() }).optional(),
  tracingOptions: tracingOptionsSchema.optional(),
});
export type DocExtractRequest = z.infer<typeof docExtractRequestSchema>;

/** ジョブの記録 (`ai_jobs` の費用・時間・モデル) に使う実行のメタ。 */
export const docExtractMeta = z.object({
  /** 実際に使われたモデル。プロバイダが返さないことがあるので null を許す。 */
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  /** モデルの生出力。`ai_extraction_payloads.raw_output` にそのまま残す。 */
  rawOutput: z.string(),
});
export type DocExtractMeta = z.infer<typeof docExtractMeta>;

export const docExtractResponseSchema = docExtractMeta.extend({
  extraction: documentExtraction,
  /** 分類の結果そのもの (どのページを何と見たか。あとで検証できるように残す)。 */
  classification: documentClassification,
  // ⚠⚠ **`promptIds` はもう返さない。** 指示文はファイル (git) にあるので、
  //   「どの指示文で読んだか」はコミットが持つ。`ai_jobs.prompt_id` は
  //   `ai_prompts.id` への外部キーなので、**符号のような文字列を入れると insert が落ちる**。
});
export type DocExtractResponse = z.infer<typeof docExtractResponseSchema>;

/**
 * ★★ 読み取りの**段**。画面はこの 4 つを縦に並べて出す。
 *
 * ⚠ `extract` の下にだけ**ノードが複数ぶら下がる** (発注書 1 通 + 依頼書 n 枚)。
 *   n は分類してみるまで分からない (`lib/group-parts.ts`)。
 * ⚠ `shape` は切り出しと対応づけ (`crop-pictures` / `link`)。
 */
export const docExtractStages = ["classify", "extract", "shape"] as const;
export type DocExtractStage = (typeof docExtractStages)[number];

/**
 * ★★ 進捗の 1 件。**ノード 1 つの状態が変わるたびに 1 行流れる。**
 *
 * ⚠⚠ **`node` は実行のあいだ変わらない鍵。** web はこれをキーに畳むので、
 *   `依頼書 2 枚目` のような**表示用の語 (`label`) を鍵に使わない**
 *   (語を変えた瞬間に別のノードとして増える)。
 * ⚠ `pending` は「これから走る」。**分類が終わった時点でまとめて流す**ので、
 *   画面は走る前から「依頼書 3 枚目 (待機)」を出せる。
 * ⚠ 進捗は**落ちてもよい**もの。受け手が切れても読み取りは続ける
 *   (`lib/progress.ts` の `emitProgress` が例外を飲む)。
 */
export const docExtractProgressEvent = z.object({
  type: z.literal("progress"),
  /** 実行のあいだ変わらない鍵 (`classify` / `po` / `spec-1` / `crop` / `link`)。 */
  node: z.string(),
  /** 画面に出す語 (`発注書` / `依頼書 1 枚目`)。 */
  label: z.string(),
  stage: z.enum(docExtractStages),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  /** epoch ミリ秒。 */
  at: z.number().int().nonnegative(),
});
export type DocExtractProgressEvent = z.infer<typeof docExtractProgressEvent>;
