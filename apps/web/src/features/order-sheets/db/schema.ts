// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/order-sheets/db/schema.ts
// この feature: ORDER SHEET(社内)
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   このリポジトリの ESLint（boundaries）が feature 間の import を禁止しているため。
//   参照先があるかはアプリ側で確かめる。

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** ORDER SHEET — 案件 1 件ぶんの指示書。社内の PO 番号と SO 番号を別に採番する */
export const orderSheets = sqliteTable(
  "order_sheets",
  {
    /** ORDER SHEET ID */
    id: text("id").primaryKey(),
    /**
     * 社内の PO 番号(社内システムが自動で発行する)
     *
     * ⚠⚠ **読み書きしない** — `cells_json` の `"D12"` が正。
     *   列は残してある (`order_sheet_lines.quantity` などと同じ扱い)。
     * ⚠ **UNIQUE 制約は外した**。同じ PO 番号を 2 枚に打てるようにするため
     *   (制約があると保存ごと落ちていた)。
     */
    poNo: text("po_no"),
    /** 社内の SO 番号。⚠ 読み書きしない (`cells_json` の `"F12"` が正)。 */
    soNo: text("so_no"),
    /** 取引先 */
    partnerId: text("partner_id").notNull(), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** ★仮。どの案件の ORDER SHEET か。案件 1 件に 1 枚 */
    caseId: text("case_id").unique(), // ソフト参照 -> cases.id(feature をまたぐので references は付けない)
    /** 主たる発注書。発注書が複数ある案件では case_id が正 */
    purchaseOrderId: text("purchase_order_id"), // ソフト参照 -> purchase_orders.id(feature をまたぐので references は付けない)
    /** お客様の発注番号(帳票に再掲する)。⚠ 読み書きしない (`"J7"` が正)。 */
    customerPoNo: text("customer_po_no"),
    /** その見出しの呼び方(取引先で違う) */
    customerPoLabel: text("customer_po_label", { enum: ["customer_po", "customer_no"] })
      .notNull()
      .default("customer_po"),
    /** 発行日(帳票の DATE 欄) */
    issuedOn: text("issued_on").notNull(),
    /**
     * SHIP 欄(営業がお客様と相談して決める)
     * ⚠⚠ **読み書きしない** — `cells_json` の `"J5"` が正。
     * ⚠ `(partner_id, ship_date)` / `(status, ship_date)` の索引はこの列に付いたままだが、
     *   書き手が居ないので**効かない**。並べ替えが要るようになったら `json_extract` に索引を張るか、
     *   この列へ書き戻すこと。
     */
    shipDate: text("ship_date"),
    /**
     * ★★ ヘッダの**セルの地図**（`{"J7": "F10000001", "D12": "9000315"}`）。
     *
     * ⚠ **後から足した列。**
     * 鍵は xlsx の番地。形の正は `lib/order-sheet-layout.ts` の
     *   `isHeaderCellRef()` / `EDITABLE_HEADER_CELLS` **だけ**。
     * ⚠⚠ **入るのは人が打つセルだけ**（`J5` / `J7` / `D12` / `F12` ＋ 工程表の `C4:E10`。
     *   工程表が加わって 4 → 25 になった）。
     *   `A12`(CUSTOMER) は `partner_id` からの派生、`J12`(DATE) は出力日からの派生なので**入れない**。
     * ⚠⚠ **疎に持つ**（空のセルは鍵ごと入れない）。`order_sheet_lines.cells_json` と同じ形。
     */
    cellsJson: text("cells_json"),
    /** 合計数量 */
    totalQuantity: integer("total_quantity").notNull().default(0),
    /** 合計の単位 */
    totalUnitCode: text("total_unit_code"), // ソフト参照 -> units.code(feature をまたぐので references は付けない)
    /** 作成したプランニング担当 */
    plannerId: text("planner_id"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 使った工程ルートの雛形 */
    routeTemplateId: text("route_template_id"), // ソフト参照 -> process_route_templates.id(feature をまたぐので references は付けない)
    /** 状態 */
    status: text("status", {
      enum: [
        "draft",
        "ai_generated",
        "in_review",
        "released",
        "in_production",
        "shipped",
        "closed",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    /** AI が起こしたか人が起こしたか */
    generatedBy: text("generated_by", { enum: ["ai", "human"] })
      .notNull()
      .default("human"),
    /** 生成した AI ジョブ */
    sourceAiJobId: text("source_ai_job_id"), // ソフト参照 -> ai_jobs.id(feature をまたぐので references は付けない)
    /** 出力した PDF */
    pdfFileId: text("pdf_file_id"), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** 現場に流した人 */
    releasedBy: text("released_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 現場に流した日時 */
    releasedAt: integer("released_at", { mode: "timestamp_ms" }),
    /** 備考 */
    note: text("note"),
    /** 現場向けの備考(タイ語) */
    noteTh: text("note_th"),
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /** 論理削除した日時 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("order_sheets_partner_idx").on(t.partnerId, t.shipDate),
    index("order_sheets_status_idx").on(t.status, t.shipDate),
    index("order_sheets_partner_id_idx").on(t.partnerId),
    index("order_sheets_case_id_idx").on(t.caseId),
    index("order_sheets_purchase_order_id_idx").on(t.purchaseOrderId),
    index("order_sheets_total_unit_code_idx").on(t.totalUnitCode),
    index("order_sheets_planner_id_idx").on(t.plannerId),
    index("order_sheets_route_template_id_idx").on(t.routeTemplateId),
    index("order_sheets_source_ai_job_id_idx").on(t.sourceAiJobId),
    index("order_sheets_pdf_file_id_idx").on(t.pdfFileId),
    index("order_sheets_released_by_idx").on(t.releasedBy),
  ],
);

export type OrderSheetsRow = typeof orderSheets.$inferSelect;
export type NewOrderSheetsRow = typeof orderSheets.$inferInsert;

/** ORDER SHEET の明細 — 帳票の 1 行。マスタへの参照と、帳票に印字する文字列の両方を持つ(未登録の新製品でも行を作れるように) */
export const orderSheetLines = sqliteTable(
  "order_sheet_lines",
  {
    /** 明細ID */
    id: text("id").primaryKey(),
    /** ORDER SHEET */
    orderSheetId: text("order_sheet_id")
      .notNull()
      .references(() => orderSheets.id, { onDelete: "cascade" }),
    /** 行番号 */
    lineNo: integer("line_no").notNull(),
    /** 社内品番(マスタ未登録なら空) */
    itemId: text("item_id"), // ソフト参照 -> items.id(feature をまたぐので references は付けない)
    /** Code 欄(プランニングが採番する) */
    itemCodeText: text("item_code_text"),
    /** お客様品番 */
    customerItemId: text("customer_item_id"), // ソフト参照 -> customer_items.id(feature をまたぐので references は付けない)
    /**
     * Code master 欄(お客様側の品番。発注書に印字されている)。
     * ⚠ **読み書きしない** — `cells_json` の `"D:0"` が正。
     */
    customerItemCodeText: text("customer_item_code_text"),
    /**
     * Code master の 2 段目(原型番号など)。
     * ⚠ **読み書きしない** — 原型No は `cells_json` の `"D17"` が正
     *   (紙の `D17`。⚠ 2 件目なら `"D23"`)。**列は残してある**(戻すときに困らないように)。
     */
    secondaryCodeText: text("secondary_code_text"),
    /** Picture 欄(プランニングの責任で用意する) */
    photoFileId: text("photo_file_id"), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** Description 欄の印字(鋳造・研磨・メッキの指定をまとめた文字列) */
    descriptionText: text("description_text"),
    /** 地金 */
    materialId: text("material_id"), // ソフト参照 -> materials.id(feature をまたぐので references は付けない)
    /** メッキ */
    platingId: text("plating_id"), // ソフト参照 -> platings.id(feature をまたぐので references は付けない)
    /** 仕上げ */
    finishId: text("finish_id"), // ソフト参照 -> finishes.id(feature をまたぐので references は付けない)
    /** 特殊な合金の指定 */
    alloyNote: text("alloy_note"),
    /** 1 個あたりの重量(mg) */
    weightPerPieceMg: integer("weight_per_piece_mg"),
    /** 号数 */
    ringSizeId: text("ring_size_id"), // ソフト参照 -> ring_sizes.id(feature をまたぐので references は付けない)
    /** Size 欄の印字(号数以外の長さなど) */
    sizeText: text("size_text"),
    /**
   * 数量。
   *
   * ⚠⚠ **読み書きしない。** 明細のセルは `cells_json` の `"I:0"` が正。
   *   NOT NULL だと行を作れないので外した。**列は残してある**（戻すときに困らないように）。
   */
    quantity: integer("quantity"),
    /** 単位。⚠ **読み書きしない**（`cells_json` の `"J:0"` が正）。 */
    unitCode: text("unit_code"), // ソフト参照 -> units.code(feature をまたぐので references は付けない)
    /** この行の Ship date */
    shipDate: text("ship_date"),
    /** Remark 欄の原文(現場への注意書き) */
    remark: text("remark"),
    /** Remark の言語 */
    remarkLang: text("remark_lang", { enum: ["th", "ja", "en", "mixed"] })
      .notNull()
      .default("th"),
    /** Remark の日本語訳 */
    remarkJa: text("remark_ja"),
    /**
   * ★★ 明細の枠の**セルの地図**（ORDER SHEET の 1 明細 = 6 行 × 10 列）。
   *
   * ⚠ **後から足したもの**。
   * 鍵は **xlsx の絶対番地**（`"F16"` = 行 16 の F 列。⚠ 2 件目は `"F22"`）。形の正は
   * `lib/order-sheet-layout.ts` の `lineCellRef()` / `parseLineCellRef()` / `isLineCellRef()`
   * **だけ**。⚠ 相対の鍵から変えた。
   * ⚠⚠ **疎に持つ**（空のセルは鍵ごと入れない）。枠は 60 セルあるが、実物で埋まるのは 10 ほど。
   * ⚠ 値は文字列。数値・日付の扱いを知っているのは **xlsx に出すところだけ**
   *   （`lib/order-sheet-xlsx.ts`。QTY は数値、SHIP DATE は文字のまま入れる）。
   */
    cellsJson: text("cells_json"),
    /** 転記元の依頼書 */
    revisionRequestId: text("revision_request_id"), // ソフト参照 -> revision_requests.id(feature をまたぐので references は付けない)
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("order_sheet_lines_no_idx").on(t.orderSheetId, t.lineNo),
    index("order_sheet_lines_item_idx").on(t.itemId),
    index("order_sheet_lines_item_id_idx").on(t.itemId),
    index("order_sheet_lines_customer_item_id_idx").on(t.customerItemId),
    index("order_sheet_lines_photo_file_id_idx").on(t.photoFileId),
    index("order_sheet_lines_material_id_idx").on(t.materialId),
    index("order_sheet_lines_plating_id_idx").on(t.platingId),
    index("order_sheet_lines_finish_id_idx").on(t.finishId),
    index("order_sheet_lines_ring_size_id_idx").on(t.ringSizeId),
    index("order_sheet_lines_unit_code_idx").on(t.unitCode),
    index("order_sheet_lines_revision_request_id_idx").on(t.revisionRequestId),
  ],
);

export type OrderSheetLinesRow = typeof orderSheetLines.$inferSelect;
export type NewOrderSheetLinesRow = typeof orderSheetLines.$inferInsert;

/**
 * ORDER SHEET の石 — Stone 欄。構造化した値と印字の両方を持つ
 *
 * ⚠⚠ **書き手が居ない。** STONE は**紙の G 列のセル**へ移した
 *   ので、値は `order_sheet_lines.cells_json` の `"G:0"` にある。
 *   1:N の器が要るのは石の内訳を持つときだけで、いまは紙の 1 セルぶんの文字しか要らない。
 *   `purchase_order_line_stones` と同じく、**表は残すが誰も書かない**
 *   (戻すときに困らないように)。⚠ 読む側も居ないので、行があっても画面には出ない。
 */
export const orderSheetLineStones = sqliteTable(
  "order_sheet_line_stones",
  {
    /** 石ID */
    id: text("id").primaryKey(),
    /** 明細 */
    orderSheetLineId: text("order_sheet_line_id")
      .notNull()
      .references(() => orderSheetLines.id, { onDelete: "cascade" }),
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
    /** 総ピース数 */
    totalPieces: integer("total_pieces"),
    /** 総カラット(1/1000) */
    totalCaratX1000: integer("total_carat_x1000"),
    /** 支給元 */
    supplySource: text("supply_source", { enum: ["in_house", "customer_supplied", "vendor"] })
      .notNull()
      .default("in_house"),
    /** 品質の指定 */
    gradeNote: text("grade_note"),
    /** Stone 欄への印字そのまま */
    displayText: text("display_text").notNull(),
    /** 並び順 */
    sortKey: integer("sort_key").notNull().default(0),
  },
  (t) => [
    index("order_sheet_line_stones_stone_type_id_idx").on(t.stoneTypeId),
    index("order_sheet_line_stones_stone_shape_id_idx").on(t.stoneShapeId),
    index("order_sheet_line_stones_stone_size_id_idx").on(t.stoneSizeId),
  ],
);

export type OrderSheetLineStonesRow = typeof orderSheetLineStones.$inferSelect;
export type NewOrderSheetLineStonesRow = typeof orderSheetLineStones.$inferInsert;

/**
 * ID 欄の採番 — 帳票の ID 欄。社内システムが発行する番号で、連番の範囲表記で書かれることがある
 *
 * ⚠⚠ **書き手が居ない。** ID は**紙の C 列のセル**へ移したので、
 *   値は `order_sheet_lines.cells_json` の `"C:0"` にある。
 *   `order_sheet_line_stones` と同じく、**表は残すが誰も書かない**（戻すときに困らないように）。
 */
export const orderSheetLineIds = sqliteTable(
  "order_sheet_line_ids",
  {
    /** 採番ID */
    id: text("id").primaryKey(),
    /** 明細 */
    orderSheetLineId: text("order_sheet_line_id")
      .notNull()
      .references(() => orderSheetLines.id, { onDelete: "cascade" }),
    /** 帳票に書かれた表記そのまま(範囲表記を含む) */
    rawText: text("raw_text").notNull(),
    /** 範囲の開始 */
    valueFrom: text("value_from"),
    /** 範囲の終わり(単一なら空) */
    valueTo: text("value_to"),
    /** この表記が表す個数 */
    valueCount: integer("value_count").notNull().default(1),
    /** 並び順 */
    sortKey: integer("sort_key").notNull().default(0),
  },
  (t) => [index("order_sheet_line_ids_line_idx").on(t.orderSheetLineId, t.sortKey)],
);

export type OrderSheetLineIdsRow = typeof orderSheetLineIds.$inferSelect;
export type NewOrderSheetLineIdsRow = typeof orderSheetLineIds.$inferInsert;

/**
 * ORDER SHEET の代表の図 — Picture 欄に出す絵。**1 明細に複数枚**持てる。
 *
 * ⚠ 後から足したもの。依頼書には代表の図が複数載ることがあり、
 *   1 枚しか持てないと「違う絵を指した」ときに人が外せない。
 * ⚠⚠ **`order_sheet_lines.photo_file_id` (代表 1 枚) は残す。** `ORDER_SHEET_FIELDS.picture` を
 *   動かすと生成 / GET / 承認 / 正答率の 4 つが同時に動く。既存データはそのまま代表になる。
 * ⚠⚠ **人が外した記録を持つのは `deleted_at` だけ。** `files.deleted_at` にも R2 の鍵にも
 *   人の判断を載せない (services/order-sheet-generator.ts の「墓標」の節)。
 * ⚠ 確信度の列は置かない。正は `ai_extraction_fields` の 1 行 (欄は 1 つのまま)。
 */
export const orderSheetLinePhotos = sqliteTable(
  "order_sheet_line_photos",
  {
    /** 写真ID */
    id: text("id").primaryKey(),
    /** 明細 */
    orderSheetLineId: text("order_sheet_line_id")
      .notNull()
      .references(() => orderSheetLines.id, { onDelete: "cascade" }),
    /** 切り出した絵の実体 */
    fileId: text("file_id").notNull(), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** 切り出し元の依頼書 */
    revisionRequestId: text("revision_request_id"), // ソフト参照 -> revision_requests.id(feature をまたぐので references は付けない)
    /** 並び順(画面の ‹ 1/3 › の順。先頭が代表) */
    sortKey: integer("sort_key").notNull().default(0),
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** ★ 人が外した日時。**読み直しで差し戻さない印**(これだけが人の判断を持つ) */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    // ⚠ 同じ絵を同じ明細に 2 行作らない(読み直しは冪等)。
    uniqueIndex("order_sheet_line_photos_file_idx").on(t.orderSheetLineId, t.fileId),
    index("order_sheet_line_photos_line_idx").on(t.orderSheetLineId, t.sortKey),
    index("order_sheet_line_photos_file_id_idx").on(t.fileId),
  ],
);

export type OrderSheetLinePhotosRow = typeof orderSheetLinePhotos.$inferSelect;
export type NewOrderSheetLinePhotosRow = typeof orderSheetLinePhotos.$inferInsert;

/** 生産計画 — PRODUCTION PLAN(プランニングが作成する)。リスケしたら版を上げて履歴を残す */
export const productionPlans = sqliteTable(
  "production_plans",
  {
    /** 計画ID */
    id: text("id").primaryKey(),
    /** ORDER SHEET */
    orderSheetId: text("order_sheet_id")
      .notNull()
      .references(() => orderSheets.id, { onDelete: "cascade" }),
    /** 版(リスケのたびに上げる) */
    version: integer("version").notNull().default(1),
    /** 今有効な版かどうか */
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    /** どう組んだか(出荷日からの逆算が既定) */
    basis: text("basis", { enum: ["backward_from_ship", "forward_from_start", "manual"] })
      .notNull()
      .default("backward_from_ship"),
    /** この版が前提にしている出荷日 */
    shipDate: text("ship_date"),
    /** 総日数 */
    totalDays: integer("total_days"),
    /** この版を作った理由(リスケの事由) */
    reason: text("reason"),
    /** 作成者 */
    createdBy: text("created_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 作成日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("production_plans_version_idx").on(t.orderSheetId, t.version),
    index("production_plans_created_by_idx").on(t.createdBy),
  ],
);

export type ProductionPlansRow = typeof productionPlans.$inferSelect;
export type NewProductionPlansRow = typeof productionPlans.$inferInsert;

/** 工程の予定と実績 — PRODUCTION PLAN の 1 行。空欄の工程も is_skipped の行として残して帳票を再現する */
export const productionPlanSteps = sqliteTable(
  "production_plan_steps",
  {
    /** 工程行ID */
    id: text("id").primaryKey(),
    /** 生産計画 */
    productionPlanId: text("production_plan_id")
      .notNull()
      .references(() => productionPlans.id, { onDelete: "cascade" }),
    /** 工程(節目の行なら空) */
    processId: text("process_id"), // ソフト参照 -> processes.id(feature をまたぐので references は付けない)
    /** 帳票での行番号 */
    seq: integer("seq").notNull(),
    /** 工程名の上書き(輸出・着荷などの節目行) */
    labelOverride: text("label_override"),
    /** 予定開始日 */
    plannedStartOn: text("planned_start_on"),
    /** 予定終了日 */
    plannedStopOn: text("planned_stop_on"),
    /** 予定日数(帳票の Day 欄) */
    plannedDays: integer("planned_days"),
    /** 実績の開始日 */
    actualStartOn: text("actual_start_on"),
    /** 実績の終了日 */
    actualStopOn: text("actual_stop_on"),
    /** この品目では行わない工程か(帳票では空欄になる) */
    isSkipped: integer("is_skipped", { mode: "boolean" }).notNull().default(false),
    /** 輸出・着荷などの節目行か */
    isMilestone: integer("is_milestone", { mode: "boolean" }).notNull().default(false),
    /** 外注かどうか */
    isOutsourced: integer("is_outsourced", { mode: "boolean" }).notNull().default(false),
    /** 状態 */
    status: text("status", { enum: ["planned", "in_progress", "done", "delayed", "skipped"] })
      .notNull()
      .default("planned"),
    /** 備考 */
    note: text("note"),
    /** 現場向けの備考(タイ語) */
    noteTh: text("note_th"),
  },
  (t) => [
    uniqueIndex("production_plan_steps_seq_idx").on(t.productionPlanId, t.seq),
    index("production_plan_steps_process_id_idx").on(t.processId),
  ],
);

export type ProductionPlanStepsRow = typeof productionPlanSteps.$inferSelect;
export type NewProductionPlanStepsRow = typeof productionPlanSteps.$inferInsert;

/** 指摘事項 — ORDER SHEET を作るときに見つかった不整合(マスタ未登録・数量が合わないなど) */
export const orderSheetIssues = sqliteTable(
  "order_sheet_issues",
  {
    /** 指摘ID */
    id: text("id").primaryKey(),
    /** ORDER SHEET */
    orderSheetId: text("order_sheet_id")
      .notNull()
      .references(() => orderSheets.id, { onDelete: "cascade" }),
    /** 該当する明細 */
    orderSheetLineId: text("order_sheet_line_id").references(() => orderSheetLines.id),
    /** 指摘の種類(後半 4 つは人が埋める欄の未入力。どれを blocker にするかは approval.ts が持つ) */
    kind: text("kind", {
      enum: [
        "item_not_registered",
        "photo_missing",
        "quantity_mismatch",
        "date_infeasible",
        "stone_unknown",
        "price_mismatch",
        "ship_date_missing",
        "code_not_assigned",
        "numbers_not_issued",
        "plan_missing",
        "other",
      ],
    }).notNull(),
    /** 重さ(blocker は現場に流せない) */
    severity: text("severity", { enum: ["info", "warning", "blocker"] })
      .notNull()
      .default("warning"),
    /** 内容 */
    message: text("message").notNull(),
    /** 解消した人 */
    resolvedBy: text("resolved_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 解消日時 */
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /** 検出日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("order_sheet_issues_severity_idx").on(t.orderSheetId, t.severity),
    index("order_sheet_issues_resolved_by_idx").on(t.resolvedBy),
  ],
);

export type OrderSheetIssuesRow = typeof orderSheetIssues.$inferSelect;
export type NewOrderSheetIssuesRow = typeof orderSheetIssues.$inferInsert;
