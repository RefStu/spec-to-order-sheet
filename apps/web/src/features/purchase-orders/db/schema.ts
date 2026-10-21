// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/purchase-orders/db/schema.ts
// この feature: 発注書(お客様)
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   このリポジトリの ESLint（boundaries）が feature 間の import を禁止しているため。
//   参照先があるかはアプリ側で確かめる。

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 受け取った帳票の原本 — 発注書と依頼書の原紙。ファイル 1 通の受領記録 */
export const poDocuments = sqliteTable(
  "po_documents",
  {
    /** 原本ID */
    id: text("id").primaryKey(),
    /** ファイル */
    fileId: text("file_id").notNull(), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /**
     * 受け取った帳票の種類(発注書 / 新製品依頼書・修正変更依頼書の原紙)
     *
     * ⚠⚠ **後から足したもの**(ai_jobs.case_id と同じ扱い)。
     *   実物は **1 つの PDF に発注書と依頼書が内包されて**届くので、
     *   「1 ファイル = 1 種類」が成り立たない。
     *   - `unknown` … 登録した時点(**まだ読んでいない**ので種類を名乗らせない)
     *   - `mixed`   … 読んだ結果、発注書と依頼書の両方が入っていた
     *   ⚠ drizzle の `text({ enum })` は CHECK を出さない(0001 の SQL で確認済み)ので、
     *     値を足すのに migration は要らない。
     */
    docKind: text("doc_kind", { enum: ["purchase_order", "spec_sheet", "mixed", "unknown"] })
      .notNull()
      .default("purchase_order"),
    /** 取引先(読み取り前は空) */
    partnerId: text("partner_id"), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /**
     * どの様式と判定したか。
     *
     * ⚠⚠ **後から足したもの**。様式ごとの指示文
     * (`ai_prompts.form_profile_id`)を引くための記録。**判定できなければ null のまま**。
     */
    formProfileId: text("form_profile_id"), // ソフト参照 -> partner_form_profiles.id(feature をまたぐので references は付けない)
    /** 様式の判定の確からしさ(0-100) */
    formConfidence: integer("form_confidence"),
    /** 状態 */
    status: text("status", {
      enum: ["received", "parsing", "parsed", "needs_review", "confirmed", "failed"],
    })
      .notNull()
      .default("received"),
    /** 受領日時 */
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    /** 備考 */
    note: text("note"),
    /**
     * 論理削除した日時。
     *
     * ⚠⚠ **後から足したもの**。間違って入れた帳票を消せるように。
     * ⚠⚠ **読む側にフィルタを入れ忘れると、消した帳票が戻ってくる。**
     *   入れる先は `listDocuments()` / `loadDocument()` / `findCaseId()` と、
     *   `registerDocument()` の **file_id の重複判定**(消した行を再アップロードに返してしまう)。
     */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("po_documents_status_idx").on(t.status, t.receivedAt),
    index("po_documents_file_id_idx").on(t.fileId),
    index("po_documents_partner_id_idx").on(t.partnerId),
    index("po_documents_form_profile_id_idx").on(t.formProfileId),
  ],
);

export type PoDocumentsRow = typeof poDocuments.$inferSelect;
export type NewPoDocumentsRow = typeof poDocuments.$inferInsert;

/** 発注書 — お客様の発注 1 件ぶんのヘッダ。金額は通貨の最小単位の整数で持つ */
export const purchaseOrders = sqliteTable(
  "purchase_orders",
  {
    /** 発注書ID */
    id: text("id").primaryKey(),
    /** 原本(手入力なら空) */
    poDocumentId: text("po_document_id").references(() => poDocuments.id),
    /** どの案件の発注書か */
    caseId: text("case_id"), // ソフト参照 -> cases.id(feature をまたぐので references は付けない)
    /** 取引先 */
    partnerId: text("partner_id").notNull(), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** お客様側の発注番号 */
    customerPoNo: text("customer_po_no").notNull(),
    /** 発注日 */
    orderedOn: text("ordered_on"),
    /** 希望出荷日 */
    requestedShipDate: text("requested_ship_date"),
    /** 到着希望日 */
    requestedArrivalDate: text("requested_arrival_date"),
    /** 支払条件の原文(マスタに無い書き方のとき) */
    paymentTermText: text("payment_term_text"),
    /** 検査完了期日の原文 */
    inspectionDueText: text("inspection_due_text"),
    /** 発注書に書かれていた担当者名(マスタに無いとき) */
    contactNameRaw: text("contact_name_raw"),
    /** 金額が税抜か税込か */
    taxMode: text("tax_mode", { enum: ["excluded", "included", "exempt"] })
      .notNull()
      .default("excluded"),
    /** 合計金額(通貨の最小単位) */
    totalAmount: integer("total_amount"),
    /** 合計数量 */
    totalQuantity: integer("total_quantity"),
    /** 状態(converted = ORDER SHEET を起こし終えた) */
    status: text("status", {
      enum: [
        "draft",
        "parsed",
        "needs_review",
        "confirmed",
        "converted",
        "partially_converted",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    /** AI が読んだ生の構造(後から項目を足すための保険) */
    rawJson: text("raw_json"),
    /** 確定させた人 */
    confirmedBy: text("confirmed_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 確定日時 */
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    /** 備考 */
    note: text("note"),
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /** 論理削除した日時 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    /**
     * ⚠⚠ **部分索引**(後から足したもの)。
     *
     *   素の UNIQUE だと **論理削除した行が鍵を握ったまま**になり、同じ取引先・同じ発注番号を
     *   入れ直せない。「読み取りをやり直す」が必ず UNIQUE 違反で落ちる。
     *   ⚠ 戻す向き(部分索引 → 素の UNIQUE)は**安全ではない**
     *     (論理削除した重複が既にあると作れない)。
     */
    uniqueIndex("purchase_orders_po_no_idx")
      .on(t.partnerId, t.customerPoNo)
      .where(sql`${t.deletedAt} is null`),
    index("purchase_orders_status_idx").on(t.status, t.requestedShipDate),
    /** 帳票 1 通ぶんを取り下げて書き直すときに引く (冪等な書き込み)。 */
    index("purchase_orders_po_document_idx").on(t.poDocumentId),
    index("purchase_orders_case_id_idx").on(t.caseId),
    index("purchase_orders_partner_id_idx").on(t.partnerId),
    index("purchase_orders_confirmed_by_idx").on(t.confirmedBy),
  ],
);

export type PurchaseOrdersRow = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrdersRow = typeof purchaseOrders.$inferInsert;

/** 発注明細 — ★お客様が書いた文字列(raw_*)と、解決した品番の両方を持つ。解決できなくても行は作る */
export const purchaseOrderLines = sqliteTable(
  "purchase_order_lines",
  {
    /** 明細ID */
    id: text("id").primaryKey(),
    /** 発注書 */
    purchaseOrderId: text("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    /** 明細の行番号 */
    lineNo: integer("line_no").notNull(),
    /** お客様側の依頼番号(帳票の No 欄) */
    customerLineNo: text("customer_line_no"),
    /** お客様が書いた品名そのまま */
    rawProductName: text("raw_product_name"),
    /** お客様が書いた品番そのまま */
    rawItemCode: text("raw_item_code"),
    /** お客様が書いた型番そのまま */
    rawModelNo: text("raw_model_no"),
    /** お客様が書いた地金の表記 */
    rawMaterialText: text("raw_material_text"),
    /** お客様が書いたサイズの表記 */
    rawSizeText: text("raw_size_text"),
    /** お客様が書いた色の表記 */
    rawColorText: text("raw_color_text"),
    /** 解決した社内品番 */
    resolvedItemId: text("resolved_item_id"), // ソフト参照 -> items.id(feature をまたぐので references は付けない)
    /** 解決したお客様品番 */
    resolvedCustomerItemId: text("resolved_customer_item_id"), // ソフト参照 -> customer_items.id(feature をまたぐので references は付けない)
    /** どうやって品番を決めたか */
    resolveMethod: text("resolve_method", {
      enum: ["exact_code", "alias_exact", "ngram", "vector", "llm", "manual", "unmatched"],
    }),
    /** 解決のスコア(0-100) */
    resolveScore: integer("resolve_score"),
    /** 解決した地金 */
    materialId: text("material_id"), // ソフト参照 -> materials.id(feature をまたぐので references は付けない)
    /** 解決したメッキ */
    platingId: text("plating_id"), // ソフト参照 -> platings.id(feature をまたぐので references は付けない)
    /** 解決した仕上げ */
    finishId: text("finish_id"), // ソフト参照 -> finishes.id(feature をまたぐので references は付けない)
    /** 解決した号数 */
    ringSizeId: text("ring_size_id"), // ソフト参照 -> ring_sizes.id(feature をまたぐので references は付けない)
    /** 号数以外のサイズ(長さなど) */
    sizeText: text("size_text"),
    /** 数量 */
    quantity: integer("quantity").notNull(),
    /** 単位 */
    unitCode: text("unit_code").notNull(), // ソフト参照 -> units.code(feature をまたぐので references は付けない)
    /** 単価(通貨の最小単位) */
    unitPrice: integer("unit_price"),
    /** 単価の小数桁数(小数の単価が来る取引先のため) */
    unitPriceScale: integer("unit_price_scale").notNull().default(0),
    /** 加工賃(通貨の最小単位) */
    processingFee: integer("processing_fee"),
    /** 地金代(通貨の最小単位) */
    materialFee: integer("material_fee"),
    /** 部材代(通貨の最小単位) */
    partsFee: integer("parts_fee"),
    /** 金額(通貨の最小単位) */
    amount: integer("amount"),
    /** 材料の準備区分 */
    supplyKind: text("supply_kind", { enum: ["in_house", "consigned", "customer_supplied"] }),
    /** この行の希望出荷日 */
    requestedShipDate: text("requested_ship_date"),
    /** この行の到着希望日 */
    requestedArrivalDate: text("requested_arrival_date"),
    /** 刻印の指定 */
    engravingText: text("engraving_text"),
    /** 摘要・備考の原文 */
    remark: text("remark"),
    /** 人の確認が要るか */
    reviewStatus: text("review_status", { enum: ["auto", "needs_review", "confirmed"] })
      .notNull()
      .default("auto"),
    /** 原本の何ページ目から読んだか */
    sourcePageNo: integer("source_page_no"),
    /** 原本上の位置(画面で該当箇所を光らせる) */
    sourceBboxJson: text("source_bbox_json"),
    /** ORDER SHEET に起こし終えた数量(分納に対応する) */
    convertedQuantity: integer("converted_quantity").notNull().default(0),
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("purchase_order_lines_no_idx").on(t.purchaseOrderId, t.lineNo),
    index("purchase_order_lines_item_idx").on(t.resolvedItemId),
    index("purchase_order_lines_review_idx").on(t.reviewStatus),
    index("purchase_order_lines_resolved_item_id_idx").on(t.resolvedItemId),
    index("purchase_order_lines_resolved_customer_item_id_idx").on(t.resolvedCustomerItemId),
    index("purchase_order_lines_material_id_idx").on(t.materialId),
    index("purchase_order_lines_plating_id_idx").on(t.platingId),
    index("purchase_order_lines_finish_id_idx").on(t.finishId),
    index("purchase_order_lines_ring_size_id_idx").on(t.ringSizeId),
    index("purchase_order_lines_unit_code_idx").on(t.unitCode),
  ],
);

export type PurchaseOrderLinesRow = typeof purchaseOrderLines.$inferSelect;
export type NewPurchaseOrderLinesRow = typeof purchaseOrderLines.$inferInsert;

/**
 * 発注明細の石 — メレの刻み別ピース数など。構造化した値と帳票の印字の両方を持つ
 *
 * ⚠⚠ **いまは書き手も読み手も居ない (孤児)。** AI の読み取りから石を外したため
 *   (`prompts/spec-sheet.ts`)。**「使われていない」と見て消さないこと** — 石の読み取りを
 *   戻すときの受け皿として残してある。ORDER SHEET の STONE 欄は
 *   `order_sheet_line_stones` に人が直接入れる。
 */
export const purchaseOrderLineStones = sqliteTable(
  "purchase_order_line_stones",
  {
    /** 石ID */
    id: text("id").primaryKey(),
    /** 発注明細 */
    purchaseOrderLineId: text("purchase_order_line_id")
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: "cascade" }),
    /** 石種 */
    stoneTypeId: text("stone_type_id"), // ソフト参照 -> stone_types.id(feature をまたぐので references は付けない)
    /** 形 */
    stoneShapeId: text("stone_shape_id"), // ソフト参照 -> stone_shapes.id(feature をまたぐので references は付けない)
    /** サイズ(刻み) */
    stoneSizeId: text("stone_size_id"), // ソフト参照 -> stone_sizes.id(feature をまたぐので references は付けない)
    /** 石の位置 */
    position: text("position", { enum: ["center", "side", "melee", "back", "other"] })
      .notNull()
      .default("melee"),
    /** 1 個あたりのピース数 */
    piecesPerUnit: integer("pieces_per_unit"),
    /** この明細での総ピース数 */
    totalPieces: integer("total_pieces"),
    /** 総カラット(1/1000) */
    totalCaratX1000: integer("total_carat_x1000"),
    /** 支給元 */
    supplySource: text("supply_source", { enum: ["in_house", "customer_supplied", "vendor"] })
      .notNull()
      .default("in_house"),
    /** 帳票の印字そのまま(構造化できない書き方を落とさない) */
    displayText: text("display_text"),
    /** お客様が書いた石の指定の原文 */
    rawText: text("raw_text"),
  },
  (t) => [
    index("purchase_order_line_stones_stone_type_id_idx").on(t.stoneTypeId),
    index("purchase_order_line_stones_stone_shape_id_idx").on(t.stoneShapeId),
    index("purchase_order_line_stones_stone_size_id_idx").on(t.stoneSizeId),
  ],
);

export type PurchaseOrderLineStonesRow = typeof purchaseOrderLineStones.$inferSelect;
export type NewPurchaseOrderLineStonesRow = typeof purchaseOrderLineStones.$inferInsert;
