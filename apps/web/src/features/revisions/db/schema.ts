// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/revisions/db/schema.ts
// この feature: 新製品依頼書・修正変更依頼書
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   このリポジトリの ESLint（boundaries）が feature 間の import を禁止しているため。
//   参照先があるかはアプリ側で確かめる。

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 新製品依頼書・修正変更依頼書 — 仕様を確定する、または確定済みの仕様を変える依頼。承認されて初めて効く */
export const revisionRequests = sqliteTable(
  "revision_requests",
  {
    /** 依頼書ID */
    id: text("id").primaryKey(),
    /** 依頼番号 */
    requestNo: text("request_no").unique(),
    /** 仕様書No(発注書の製造番号・ORDER SHEET の Code master と同じ番号) */
    specNo: text("spec_no"),
    /** 前の版の依頼書ID(改訂を重ねる。自己参照のため外部キーは張らない) */
    revisionOfId: text("revision_of_id"),
    /** 版 */
    version: integer("version").notNull().default(1),
    /** 取引先 */
    partnerId: text("partner_id").notNull(), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** どの案件の依頼書か */
    caseId: text("case_id"), // ソフト参照 -> cases.id(feature をまたぐので references は付けない)
    /** 対象の社内品番 */
    itemId: text("item_id"), // ソフト参照 -> items.id(feature をまたぐので references は付けない)
    /** 対象のお客様品番 */
    customerItemId: text("customer_item_id"), // ソフト参照 -> customer_items.id(feature をまたぐので references は付けない)
    /** 関係する ORDER SHEET */
    orderSheetId: text("order_sheet_id"), // ソフト参照 -> order_sheets.id(feature をまたぐので references は付けない)
    /** 関係する発注書 */
    purchaseOrderId: text("purchase_order_id"), // ソフト参照 -> purchase_orders.id(feature をまたぐので references は付けない)
    /**
     * 結びついた発注書の**明細 1 行**。
     *
     * ⚠⚠ **後から足したもの**。ai の対応づけ(`links`)は
     *   **PDF の中の添字**しか持たないので、同じ読み取りのうちに D1 の ID へ開いて
     *   ここに置く。ORDER SHEET の組み立ては**別のジョブ**で D1 の UUID から始まるため、
     *   ここに残しておかないと対応づけが届かない
     *   (uuidv7 は同一ミリ秒内で単調ではないので、並び順から添字は復元できない)。
     * ⚠ **規則で結べたものはここに入れない。** 入るのは規則 (`matchBySpecNo`) が
     *   結べなかったぶんだけ (`applyAiLinks` と同じ性質)。**読めなければ null のまま**。
     */
    purchaseOrderLineId: text("purchase_order_line_id"), // ソフト参照 -> purchase_order_lines.id(feature をまたぐので references は付けない)
    /** 読み取り元の原紙 */
    sourcePoDocumentId: text("source_po_document_id"), // ソフト参照 -> po_documents.id(feature をまたぐので references は付けない)
    /** 新規の仕様決めか、変更か、誤りの訂正か */
    requestType: text("request_type", { enum: ["new_spec", "revision", "correction"] })
      .notNull()
      .default("new_spec"),
    /** 注文区分(加工 / 組合せ / 鋳造 / 修理) */
    orderCategory: text("order_category", {
      enum: ["processing", "combination", "casting", "repair", "other"],
    }),
    /** 加工内容 */
    processingDetail: text("processing_detail"),
    /** 依頼元への戻し方(本人渡し / 部署直送 / お客様直送) */
    deliverTo: text("deliver_to", {
      enum: ["bare_piece", "attachment", "department_direct", "customer_direct", "other"],
    }),
    /** 得意先コードの印字 */
    customerCodeText: text("customer_code_text"),
    /** 顧客管理コード */
    customerMgmtCode: text("customer_mgmt_code"),
    /** 品名(Production Name) */
    productionName: text("production_name"),
    /** 依頼の理由 */
    reason: text("reason"),
    /** 状態(parsed = 原紙を読み取って行を作った。purchase_orders と同じ語に揃えてある) */
    status: text("status", {
      enum: ["draft", "parsed", "submitted", "approved", "rejected", "applied", "cancelled"],
    })
      .notNull()
      .default("draft"),
    /** AI が読み取って起こした行か、人が手入力したか(依頼書そのものはお客様から届く) */
    generatedBy: text("generated_by", { enum: ["ai", "human"] })
      .notNull()
      .default("human"),
    /** 読み取った AI ジョブ */
    sourceAiJobId: text("source_ai_job_id"), // ソフト参照 -> ai_jobs.id(feature をまたぐので references は付けない)
    /** 社内で受け付けた人。依頼者そのものはお客様 */
    requestedBy: text("requested_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 依頼日時 */
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    /** 承認者 */
    approvedBy: text("approved_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 承認日時 */
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    /** 内容をマスタ・帳票に反映した日時 */
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
    /** 出力した PDF */
    pdfFileId: text("pdf_file_id"), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /** 論理削除した日時 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("revision_requests_partner_idx").on(t.partnerId, t.status),
    index("revision_requests_item_idx").on(t.itemId, t.version),
    index("revision_requests_spec_no_idx").on(t.partnerId, t.specNo),
    index("revision_requests_partner_id_idx").on(t.partnerId),
    index("revision_requests_case_id_idx").on(t.caseId),
    index("revision_requests_item_id_idx").on(t.itemId),
    index("revision_requests_customer_item_id_idx").on(t.customerItemId),
    index("revision_requests_order_sheet_id_idx").on(t.orderSheetId),
    index("revision_requests_purchase_order_id_idx").on(t.purchaseOrderId),
    index("revision_requests_purchase_order_line_id_idx").on(t.purchaseOrderLineId),
    index("revision_requests_source_po_document_id_idx").on(t.sourcePoDocumentId),
    index("revision_requests_source_ai_job_id_idx").on(t.sourceAiJobId),
    index("revision_requests_requested_by_idx").on(t.requestedBy),
    index("revision_requests_approved_by_idx").on(t.approvedBy),
    index("revision_requests_pdf_file_id_idx").on(t.pdfFileId),
  ],
);

export type RevisionRequestsRow = typeof revisionRequests.$inferSelect;
export type NewRevisionRequestsRow = typeof revisionRequests.$inferInsert;

/** 依頼書の仕様 — 素材・純度・刻印・仕上げ場所など、依頼書の本体にあたる仕様。依頼書 1 通に 1 行 */
export const revisionRequestSpecs = sqliteTable(
  "revision_request_specs",
  {
    /** 仕様ID */
    id: text("id").primaryKey(),
    /** 依頼書 */
    revisionRequestId: text("revision_request_id")
      .notNull()
      .references(() => revisionRequests.id, { onDelete: "cascade" }),
    /** 素材 */
    materialId: text("material_id"), // ソフト参照 -> materials.id(feature をまたぐので references は付けない)
    /** 素材コードの印字 */
    materialCodeText: text("material_code_text"),
    /** 純度の指定 */
    purityText: text("purity_text"),
    /**
     * 原型番号。
     *
     * ⚠⚠ **後から足したもの**。実物の ORDER SHEET では
     *   **Code master の 2 段目**がこの番号で、出どころは依頼書にしか無い。
     */
    moldNo: text("mold_no"),
    /** 認定の要否 */
    certification: text("certification", { enum: ["none", "required", "customer_provided"] })
      .notNull()
      .default("none"),
    /** メッキ */
    platingId: text("plating_id"), // ソフト参照 -> platings.id(feature をまたぐので references は付けない)
    /** 仕上げ */
    finishId: text("finish_id"), // ソフト参照 -> finishes.id(feature をまたぐので references は付けない)
    /** 号数 */
    ringSizeId: text("ring_size_id"), // ソフト参照 -> ring_sizes.id(feature をまたぐので references は付けない)
    /** サイズの指定(号数以外) */
    sizeText: text("size_text"),
    /** 全長(1/100 mm) */
    fullLengthMmX100: integer("full_length_mm_x100"),
    /** チェーンの指定 */
    chainSpecText: text("chain_spec_text"),
    /** ピアスポスト・キャッチなどの指定 */
    findingText: text("finding_text"),
    /** 刻印の内容 */
    engravingText: text("engraving_text"),
    /** 刻印の方法 */
    engravingMethod: text("engraving_method", { enum: ["laser", "press", "none"] })
      .notNull()
      .default("none"),
    /** 刻印の位置 */
    engravingPosition: text("engraving_position"),
    /** 石目の合計(カラットの1/1000) */
    totalStoneWeightCaratX1000: integer("total_stone_weight_carat_x1000"),
    /** 想定重量(mg) */
    specWeightMg: integer("spec_weight_mg"),
    /** 溶解の場所 */
    meltProductionPlace: text("melt_production_place", {
      enum: ["in_house", "outside", "consigned"],
    }),
    /** 型の製作場所 */
    moldProductionPlace: text("mold_production_place", {
      enum: ["in_house", "outside", "consigned"],
    }),
    /** 最終仕上げの場所 */
    finalFinishPlace: text("final_finish_place", { enum: ["in_house", "outside", "consigned"] }),
    /** サンプルの到着日 */
    sampleArrivalOn: text("sample_arrival_on"),
    /** 仕上げの注意(OK/NG の説明) */
    finishCaution: text("finish_caution"),
    /** 備考 */
    remark: text("remark"),
    /*
     * ★ 依頼書の**下部に印字したメモ**。**印字そのまま。**
     *
     * ⚠⚠ **後から足したもの**。**将来は消す機能**なので、
     *   既存の列 (`size_text` など) を使い回さず `note_` の 5 列にまとめてある。
     *   消すときはこの 5 列を消して migration を 1 本足す
     *   (ほかの消す場所は ai の `contract.ts` の `specNoteFields` の注記)。
     * ⚠ 書くのは `revisions/services/spec-writer.ts`、読むのは
     *   `order-sheets/services/order-sheet-generator.ts` の `fillFromSpecNote()` だけ。
     */
    /** メモの `Size`。⚠ 発注書のサイズが空の明細だけに使う (Size `H16`)。 */
    noteSizeText: text("note_size_text"),
    /** メモの `STONE` (`G16`)。 */
    noteStoneText: text("note_stone_text"),
    /** メモの `Description#2` (POLISH `F17`)。 */
    noteDescription2: text("note_description2"),
    /** メモの `Description#3` (メッキ `F18`)。 */
    noteDescription3: text("note_description3"),
    /** メモの `Description#4` (ロゴ `F20`)。 */
    noteDescription4: text("note_description4"),
  },
  (t) => [
    index("revision_request_specs_material_id_idx").on(t.materialId),
    index("revision_request_specs_plating_id_idx").on(t.platingId),
    index("revision_request_specs_finish_id_idx").on(t.finishId),
    index("revision_request_specs_ring_size_id_idx").on(t.ringSizeId),
  ],
);

export type RevisionRequestSpecsRow = typeof revisionRequestSpecs.$inferSelect;
export type NewRevisionRequestSpecsRow = typeof revisionRequestSpecs.$inferInsert;

/**
 * 依頼書の石 — メレの刻み別ピース数。刻みが増えても列を足さずに済むよう縦持ちにする
 *
 * ⚠⚠ **いまは書き手も読み手も居ない (孤児)。** 事情は
 *   `purchase-orders/db/schema.ts` の `purchaseOrderLineStones` と同じ。**消さないこと。**
 */
export const revisionRequestStones = sqliteTable(
  "revision_request_stones",
  {
    /** 石ID */
    id: text("id").primaryKey(),
    /** 依頼書 */
    revisionRequestId: text("revision_request_id")
      .notNull()
      .references(() => revisionRequests.id, { onDelete: "cascade" }),
    /** 石種 */
    stoneTypeId: text("stone_type_id"), // ソフト参照 -> stone_types.id(feature をまたぐので references は付けない)
    /** 形 */
    stoneShapeId: text("stone_shape_id"), // ソフト参照 -> stone_shapes.id(feature をまたぐので references は付けない)
    /** サイズ(刻み) */
    stoneSizeId: text("stone_size_id"), // ソフト参照 -> stone_sizes.id(feature をまたぐので references は付けない)
    /** 石の位置(中石 / 内石 / メレ) */
    position: text("position", { enum: ["center", "side", "melee", "back", "other"] })
      .notNull()
      .default("melee"),
    /** ピース数 */
    pieces: integer("pieces").notNull(),
    /** 支給元 */
    supplySource: text("supply_source", { enum: ["in_house", "customer_supplied", "vendor"] })
      .notNull()
      .default("in_house"),
    /** 備考 */
    remark: text("remark"),
    /** 並び順 */
    sortKey: integer("sort_key").notNull().default(0),
  },
  (t) => [
    index("revision_request_stones_stone_type_id_idx").on(t.stoneTypeId),
    index("revision_request_stones_stone_shape_id_idx").on(t.stoneShapeId),
    index("revision_request_stones_stone_size_id_idx").on(t.stoneSizeId),
  ],
);

export type RevisionRequestStonesRow = typeof revisionRequestStones.$inferSelect;
export type NewRevisionRequestStonesRow = typeof revisionRequestStones.$inferInsert;
