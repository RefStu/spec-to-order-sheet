import { z } from "zod";
import { HEADER_VALUE_CELLS, isLineCellRef } from "./lib/order-sheet-layout";

/**
 * ★★ ORDER SHEET の API の契約 — **画面と Worker の唯一の接点**。
 *
 * ⚠⚠ **この形を変えると画面 (features/cases) が黙って壊れる。**
 * ⚠ **api/routes.ts が変えてよいのは「値の出どころ」だけで、ここの zod は動かさない。**
 * ⚠⚠ **工程表 (PRODUCTION PLAN) の日付もこの契約に入っている。**
 *    **人が自由な文字を打つ形にしてある**ので、英語の工程名と日本語の工程名の
 *    対応を決めなくてよい。置き場所は他のヘッダと同じ
 *    `order_sheets.cells_json` で、番地は `C4:E10` (`PLAN_CELLS`)。
 */

/** ORDER SHEET の状態 (`db/schema.ts` の enum が正)。 */
export const orderSheetStatusSchema = z.enum([
  "draft",
  "ai_generated",
  "in_review",
  "released",
  "in_production",
  "shipped",
  "closed",
  "cancelled",
]);
export type OrderSheetStatus = z.infer<typeof orderSheetStatusSchema>;

/** 欄の値。⚠ 写真の欄には `files.id` が入る (画面が `/api/files/:id/original` で取る)。 */
export const fieldValueSchema = z.union([z.string(), z.number(), z.null()]);
export type FieldValue = z.infer<typeof fieldValueSchema>;

/**
 * ★ すべての欄が同じ形で返る。
 *
 * ⚠⚠ **「どの欄が AI で、どの欄が人か」のリストを画面側に持たせないための仕掛け。**
 *   出どころを知っているのは読み取りを走らせた側だけなので、**API が事実を返し、
 *   画面は filledBy / confidence / corrected を見て塗り分けるだけ**にする。
 */
export const fieldSchema = z.object({
  value: fieldValueSchema,
  /**
   * ★ **本来どちらが埋める欄か**。`filledBy` (実際に誰が埋めたか) とは別物。
   *
   * ⚠⚠ これが無いと、画面は「まだ AI が埋めていない欄」と「人が埋める空欄」を
   *   区別できず、**欄のキーの一覧を画面に持つ**ことになる (それは必ず API とずれる)。
   *   正は `order-sheets/lib/order-sheet-fields.ts` の 1 か所のまま。
   */
  by: z.enum(["ai", "human"]),
  /** null = まだ誰も入れていない (= 人が埋める欄で未入力)。 */
  filledBy: z.enum(["ai", "human"]).nullable(),
  /** filledBy === "ai" のときだけ入る。 */
  confidence: z.number().nullable(),
  /** AI が埋めたあと人が直した。 */
  corrected: z.boolean(),
  /** 原本の何ページのどこから来たか。 */
  source: z
    .object({
      page: z.number().int(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
    .nullable(),
});
export type Field = z.infer<typeof fieldSchema>;

/**
 * 欄のキー。**これは「帳票の形」であって「誰が埋めるか」ではない。**
 * AI か人かを答えるのは filledBy だけ。
 */
/**
 * ヘッダの欄。**並びは実物の ORDER SHEET のとおり。**
 *
 * ⚠ `CUSTOMER_PO_NO` はお客様の発注No で、**帳票の右上**にある独立した欄
 *   (`J7`)。社内システムが発行する `PO` / `SO` (`D12` / `F12`) とは別物。
 * ⚠ `PO` と `SO` は **DB でもここでも別の欄**。1 欄にまとめない
 *   (`"<PO> / <SO>"` のような詰め込みは、どちらが欠けているのかを見えなくする)。
 */
/**
 * ⚠⚠ **リテラルのタプルを保つこと。** `z.enum()` は閉じた集合を要求するので、
 *   `.map()` や `string[]` の変数を混ぜると**未知の番地を弾けなくなる**。
 *   `as const` のタプルを spread するぶんにはリテラル型が保たれる。
 * ⚠ 中身は `HEADER_VALUE_CELLS`（人が打つ `J5` `J7` `D12` `F12` ＋ 工程表の 21 個）
 *   ＋ **読み取り専用の派生 2 つ**（`A12` / `J12`）。
 *   ⚠ `F5`（取引先名）は**入れない** — 派生なうえ、入れると PATCH で打ててしまう。
 */
export const headerFieldKeys = [...HEADER_VALUE_CELLS, "A12", "J12"] as const;
/**
 * ⚠⚠ **名前から番地へ変えた。** `CUSTOMER` → `A12` /
 *   `CUSTOMER_PO_NO` → `J7` / `PO` → `D12` / `SO` → `F12` / `SHIP` → `J5`。
 *   **`J12`（DATE）が新しく欄になった** — それまで画面が「未入力」の箱を手で描いていた。
 * ⚠ `A12`（CUSTOMER）と `J12`（DATE）は**読み取り専用の派生**。PATCH で送られても捨てる
 *   （前者は `partner_id`、後者は xlsx を出した日から出る）。
 */

/**
 * ★★ 明細の**セルの番地**（`"F16"`）。
 *
 * ⚠⚠ **欄の名前（`CODE_MASTER` など）はもう使わない。** 明細を
 *   「欄の集まり」から**「紙と同じセルの格子」**に変えた。画面のどのセルにも打ち込めて、
 *   打った値がそのまま xlsx の同じ番地に出る。
 * ⚠⚠ **相対の鍵（`"F:0"`）から xlsx の絶対番地へ変えた。**
 *   ヘッダも見出しも同じ体系になり、**画面から見える住所が xlsx と 1 対 1** になった。
 * ⚠ 形の正は `lib/order-sheet-layout.ts` の `lineCellRef()` / `isLineCellRef()` **だけ**。
 *   ここは「番地として通す形か」を見るだけで、**一覧は持たない**（720 個を書き写さない）。
 * ⚠ A 列（連番）と E 列（写真）は番地にならない。写真は `photos` が持つ。
 */
export const cellKeySchema = z
  .string()
  .refine(isLineCellRef, { message: "セルの番地ではありません" });

export type HeaderFieldKey = (typeof headerFieldKeys)[number];

// ⚠ zod 4 の `z.record(z.enum(...))` は **enum の全キーを必須**にする。
//   欄は「まだ無い」ことがある (AI が書かない欄・読み取り側が返さない欄) ので partialRecord を使う。
const headerFieldsSchema = z.partialRecord(z.enum(headerFieldKeys), fieldSchema);
// ⚠ セルは 60 個あって大半が空なので、**疎な地図**にする（空のセルは鍵ごと入れない）。
const lineCellsSchema = z.record(cellKeySchema, fieldSchema);

/**
 * ★ 明細に付いている**代表の図 1 枚**。
 *
 * ⚠⚠ **確信度も `filledBy` も持たせない。** 欄 (`PICTURE`) は 1 つのままなので塗り分けも 1 色。
 *   ここに持たせると `ORDER_SHEET_FIELDS.picture` の `table` を動かすことになり、
 *   正答率の分母と generator のテストが一緒に動く。
 * ⚠ 値は `files.id`。画面は `/api/files/:fileId/original` で取りに行く。
 */
export const orderSheetLinePhotoSchema = z.object({
  photoId: z.string(),
  fileId: z.string(),
  sortKey: z.number().int(),
});
export type OrderSheetLinePhoto = z.infer<typeof orderSheetLinePhotoSchema>;

export const orderSheetLineSchema = z.object({
  lineId: z.string(),
  lineNo: z.number().int(),
  /**
   * ★ 代表の図。**1 明細に複数枚**。画面は `‹ 1/3 ›` で 1 枚ずつ出し、ゴミ箱で外せる。
   *
   * ⚠⚠ **`fields.PICTURE` は代表 1 枚のまま。** ここはその内訳で、代表はこの配列の先頭。
   * ⚠ 人が外した絵は返らない (`order_sheet_line_photos.deleted_at`)。
   * ⚠ `.default([])` を付けてあるので、古い形の応答でも画面は落ちない。
   */
  photos: z.array(orderSheetLinePhotoSchema).default([]),
  /**
   * ★ Picture 欄（E 列）の**代表 1 枚**。
   *
   * ⚠⚠ **これだけはセルの地図に入れない。** E 列は文字ではなく絵で、実体は
   *   `order_sheet_line_photos` と R2 にある。値は `files.id`。
   * ⚠ 塗り分けと正答率の集計のために `fieldSchema` の形は保つ（`ORDER_SHEET_FIELDS.picture`）。
   */
  picture: fieldSchema,
  /**
   * ★★ 枠のセル。鍵は **xlsx の絶対番地**（`"F16"` = 行 16 の F 列。2 件目なら `"F22"`）。
   *
   * ⚠ **空のセルは入っていない。** 画面は `lineCellRefs()` の形で格子を自分で作り、
   *   無い鍵は空欄にする（画面側の入口は `cases/lib/order-sheet-sections.ts` の `buildOrderSheetForm()`）。
   */
  cells: lineCellsSchema,
});

/**
 * 現場に流せない不整合 (order_sheet_issues)。
 *
 * ⚠⚠ **GET の応答には載らない。** 画面から「残っている不整合」を外した
 *   ので、この形が出るのは**承認の結果 (`approveResultSchema`) だけ**になった。
 *   ⚠ その承認も画面には無い (API とサービスは残してある)。表 `order_sheet_issues` も残る。
 */
export const issueSchema = z.object({
  kind: z.string(),
  severity: z.enum(["info", "warning", "blocker"]),
  message: z.string(),
  lineId: z.string().nullable(),
});
export type Issue = z.infer<typeof issueSchema>;

export const orderSheetSchema = z.object({
  caseId: z.string(),
  orderSheetId: z.string(),
  status: orderSheetStatusSchema,
  /**
   * ★ 「確信度が低い」の閾値も API が返す。
   *   画面側に数値を持たせると、読み取り側を調整したときにずれる。
   */
  confidenceThreshold: z.number(),
  header: headerFieldsSchema,
  /**
   * ⚠ **取り込み中は空の明細が 1 行入る** (`lineId` が空文字)。0 行だと画面に表そのものが
   *   出ないため。**その行は保存に混ぜない** (`lineId` が空なら読み取り専用)。
   */
  lines: z.array(orderSheetLineSchema),
});
export type OrderSheet = z.infer<typeof orderSheetSchema>;

/**
 * 人が埋める欄の保存。
 *
 * ⚠⚠ **AI の欄を人が直したときは corrections に載せること。**
 *   ai_field_corrections に記録され、正答率の分母になる。
 */
export const correctionErrorKinds = [
  "ocr", // 文字の読み間違い
  "mapping", // 対応づけの間違い
  "unit", // 単位の間違い
  "date", // 日付の間違い
  "missed", // 読み落とし
  "fabricated", // でっち上げ
] as const;

export const correctionSchema = z.object({
  fieldKey: z.string(),
  /** ヘッダの欄なら null。 */
  lineId: z.string().nullable(),
  previousValue: fieldValueSchema,
  newValue: fieldValueSchema,
  errorKind: z.enum(correctionErrorKinds).nullable(),
});
export type Correction = z.infer<typeof correctionSchema>;

export const patchOrderSheetInput = z.object({
  // ⚠ 部分更新なので partialRecord (直した欄だけが載ってくる)。
  header: z.partialRecord(z.enum(headerFieldKeys), fieldValueSchema).optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string(),
        // ⚠ 打ち込まれたセルだけが載ってくる（画面の「保存」を押した時点の差分）。
        cells: z.record(cellKeySchema, fieldValueSchema),
      }),
    )
    .optional(),
  corrections: z.array(correctionSchema).default([]),
});
export type PatchOrderSheetInput = z.input<typeof patchOrderSheetInput>;

/**
 * 承認できる条件。
 * ⚠ **判定を画面側に持たない。** どれを blocker にするかは後から変わりうるので、
 *   services/approval.ts の 1 か所だけが知っている。
 */
export const approveResultSchema = z.object({
  ok: z.boolean(),
  status: orderSheetStatusSchema,
  blockers: z.array(issueSchema),
  warnings: z.array(issueSchema),
});
export type ApproveResult = z.infer<typeof approveResultSchema>;
