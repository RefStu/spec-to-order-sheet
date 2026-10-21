import { z } from "zod";

/**
 * ★ feature `order-sheets` の `GET /api/order-sheets/:caseId` が返す形を、**画面側に写したもの**。
 *
 * ⚠ **なぜ写すのか。** ESLint の boundaries が feature 間の import を
 *   `import type` でも禁止しているので、`features/order-sheets/schema.ts` は読めない。
 *   接点は HTTP だけ。
 * ⚠ **形が変わったらここも直す。** 片側だけ変えると画面が黙って壊れる。
 * ⚠ status は `z.string()` にしてある。Worker 側が状態を足しても画面は落ちない。
 */

export const fieldValueSchema = z.union([z.string(), z.number(), z.null()]);
export type FieldValue = z.infer<typeof fieldValueSchema>;

/**
 * ★★ すべての欄がこの形で返る。
 *   **AI が埋めたか人が埋めるかを答えるのは filledBy だけ** で、
 *   画面は欄のキーからそれを判断しない。
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
  filledBy: z.enum(["ai", "human"]).nullable(),
  confidence: z.number().nullable(),
  corrected: z.boolean(),
  source: z
    .object({
      page: z.number().int(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
    .nullable(),
});
export type Field = z.infer<typeof fieldSchema>;

/**
 * 明細に付いている代表の図 1 枚 (`order-sheets/schema.ts` の `orderSheetLinePhotoSchema` の写し)。
 * ⚠ 確信度も filledBy も持たない。欄は 1 つのままなので塗り分けも 1 色。
 */
export const orderSheetLinePhotoSchema = z.object({
  photoId: z.string(),
  fileId: z.string(),
  sortKey: z.number().int(),
});
export type OrderSheetLinePhoto = z.infer<typeof orderSheetLinePhotoSchema>;

export const orderSheetSchema = z.object({
  caseId: z.string(),
  orderSheetId: z.string(),
  status: z.string(),
  /** ★ 「確信度が低い」の閾値は API が返す。画面側に数値を持たない。 */
  confidenceThreshold: z.number(),
  header: z.record(z.string(), fieldSchema),
  /**
   * ⚠ **取り込み中は空の明細が 1 行入る** (`lineId` が空文字)。0 行だと表そのものが
   *   出ないため。**その行は編集させない** (保存に混ぜない)。
   */
  lines: z.array(
    z.object({
      lineId: z.string(),
      lineNo: z.number().int(),
      /**
       * ★ 代表の図。**1 明細に複数枚**。画面は 1 枚ずつ出して、ゴミ箱で外せる。
       * ⚠ 代表の 1 枚は `picture` のまま (この配列の先頭と一致する)。
       * ⚠ `.default([])`。API が返さない形でも画面は落ちない。
       */
      photos: z.array(orderSheetLinePhotoSchema).default([]),
      /** ★ Picture 欄 (E 列) の代表 1 枚。⚠ セルの地図には入らない (文字ではなく絵)。 */
      picture: fieldSchema,
      /**
       * ★★ 枠のセル。鍵は **xlsx の絶対番地**（`"F16"` = 行 16 の F 列。2 件目なら `"F22"`）。
       *
       * ⚠⚠ 相対の鍵（`"F:0"`）から変えた。**画面と xlsx の住所が
       *   1 対 1** になり、「鍵」と「番地」を別々に持つ必要が無くなった。
       * ⚠ **空のセルは入っていない。** 画面は無い鍵を空欄として出す。
       */
      cells: z.record(z.string(), fieldSchema),
    }),
  ),
});
export type OrderSheet = z.infer<typeof orderSheetSchema>;

/**
 * 「読み取りをやり直す」の 202 (`POST /api/purchase-orders/documents/:documentId/reextract`)。
 * ⚠ 前の結果は `ai_extractions.version` を上げて残る (消えない)。
 */
export const reextractResultSchema = z.object({
  jobId: z.string(),
  /** ⚠ API が返すのは常に "accepted"。語彙は features/cases/schema.ts の progressSchema と同じ。 */
  status: z.string(),
});
export type ReextractResult = z.infer<typeof reextractResultSchema>;

export const documentListSchema = z.object({
  caseId: z.string(),
  documents: z.array(
    z.object({
      documentId: z.string(),
      docKind: z.string(),
      formPattern: z.string().nullable(),
      receivedOn: z.string().nullable(),
      pageCount: z.number().int().nullable(),
      extractionStatus: z.string(),
      originalUrl: z.string().nullable(),
    }),
  ),
});
export type DocumentList = z.infer<typeof documentListSchema>;

/**
 * 欄の見出し。**「誰が埋めるか」ではなく「帳票の形」**。
 * ⚠ ここに「AI の欄 / 人の欄」を書かないこと。出す順と日本語の見出しだけ。
 */
export const HEADER_FIELD_LABELS: Record<string, string> = {
  A12: "CUSTOMER",
  J7: "Customer PO",
  D12: "PO",
  F12: "SO",
  J5: "SHIP",
  J12: "DATE",
};

/**
 * ⚠ **人が打てないヘッダの欄**（値は出るが入力させない）。
 *   `A12` は取引先マスタ（`partner_id`）からの派生、`J12` は xlsx を出した日からの派生。
 *   ⚠ order-sheets 側の writer も同じ 2 つを捨てる。**ここを外すと、打てるのに保存されない欄ができる。**
 */
export const READ_ONLY_HEADER_KEYS: readonly string[] = ["A12", "J12"];

/*
 * ⚠⚠ **欄の置き場所の表はここに持たない。** 番地と別に持つと必ずずれる。
 *   ⚠ 実物の配置についての注意:
 *   **Customer PO(`J7`) を CUSTOMER(`A12`) と並べない**（紙の反対側にあり、出どころも違う。
 *   前者はお客様の発注書に印字、後者と `PO`/`SO` は社内システムの採番）。
 *   **`PO`(`D12`) と `SO`(`F12`) は別の欄**。1 欄にまとめない。
 *
 * ⚠ 番地と見出しの文字は `lib/order-sheet-form.ts`、区画と欄の組み立ては
 *   `lib/order-sheet-sections.ts` が持つ。
 */

/** 保存で送る、人が直した記録。 */
export const correctionErrorKinds = [
  "ocr",
  "mapping",
  "unit",
  "date",
  "missed",
  "fabricated",
] as const;
export type CorrectionErrorKind = (typeof correctionErrorKinds)[number];

export interface Correction {
  fieldKey: string;
  lineId: string | null;
  previousValue: FieldValue;
  newValue: FieldValue;
  errorKind: CorrectionErrorKind | null;
}
