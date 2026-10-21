// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/catalog/db/schema.ts
// この feature: 品番
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   ESLint が feature 間の import を禁止しているため。
//   孤児の検出は持っていない。

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 社内品番 — ORDER SHEET の Code 欄。プランニングが採番する、製造の単位 */
export const items = sqliteTable(
  "items",
  {
    /** 品番ID */
    id: text("id").primaryKey(),
    /** 社内品番(プランニングが採番) */
    code: text("code").notNull().unique(),
    /** 取引先 */
    partnerId: text("partner_id").notNull(), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** 社内での品名 */
    nameJa: text("name_ja").notNull(),
    /** 英字の品名(帳票への印字) */
    nameEn: text("name_en"),
    /** 品目種別 */
    category: text("category", {
      enum: ["ring", "earring", "necklace", "bracelet", "pendant", "object", "other"],
    }).notNull(),
    /** 品番を規則で分解した結果(種別・年月・取引先などの記号) */
    codePartsJson: text("code_parts_json"),
    /** 既定の地金 */
    defaultMaterialId: text("default_material_id"), // ソフト参照 -> materials.id(feature をまたぐので references は付けない)
    /** 既定のメッキ */
    defaultPlatingId: text("default_plating_id"), // ソフト参照 -> platings.id(feature をまたぐので references は付けない)
    /** 既定の仕上げ */
    defaultFinishId: text("default_finish_id"), // ソフト参照 -> finishes.id(feature をまたぐので references は付けない)
    /** 既定の工程ルート */
    routeTemplateId: text("route_template_id"), // ソフト参照 -> process_route_templates.id(feature をまたぐので references は付けない)
    /** 標準重量(mg) */
    standardWeightMg: integer("standard_weight_mg"),
    /** 代表写真 */
    mainPhotoId: text("main_photo_id"), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** 製造可能サイズの範囲(帳票の文言) */
    sizeRangeNote: text("size_range_note"),
    /** 備考 */
    remark: text("remark"),
    /** 現場向けの備考(現場の言語) */
    remarkTh: text("remark_th"),
    /** 初回受注日 */
    firstOrderedOn: text("first_ordered_on"),
    /** 生産中かどうか */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /** 論理削除した日時 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("items_partner_idx").on(t.partnerId, t.category),
    index("items_partner_id_idx").on(t.partnerId),
    index("items_default_material_id_idx").on(t.defaultMaterialId),
    index("items_default_plating_id_idx").on(t.defaultPlatingId),
    index("items_default_finish_id_idx").on(t.defaultFinishId),
    index("items_route_template_id_idx").on(t.routeTemplateId),
    index("items_main_photo_id_idx").on(t.mainPhotoId),
  ],
);

export type ItemsRow = typeof items.$inferSelect;
export type NewItemsRow = typeof items.$inferInsert;

/** お客様の品番 — ORDER SHEET の Code master 欄。1 つの社内品番に複数ぶら下がることがある */
export const customerItems = sqliteTable(
  "customer_items",
  {
    /** お客様品番ID */
    id: text("id").primaryKey(),
    /** 取引先 */
    partnerId: text("partner_id").notNull(), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** お客様側の品番 */
    code: text("code").notNull(),
    /** 品番の種類(帳票に第2コードが併記されることがある) */
    codeKind: text("code_kind", { enum: ["primary", "secondary", "model_no", "jan"] })
      .notNull()
      .default("primary"),
    /** お客様が付けている品名 */
    nameByCustomer: text("name_by_customer"),
    /** 使用中かどうか */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /** 初めて見た日時 */
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    /** 最後に見た日時 */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("customer_items_code_idx").on(t.partnerId, t.code),
    index("customer_items_partner_id_idx").on(t.partnerId),
  ],
);

export type CustomerItemsRow = typeof customerItems.$inferSelect;
export type NewCustomerItemsRow = typeof customerItems.$inferInsert;

/** 商品写真 — ORDER SHEET の Picture 欄に出す写真。プランニングの責任で登録する */
export const itemPhotos = sqliteTable(
  "item_photos",
  {
    /** 写真ID */
    id: text("id").primaryKey(),
    /** 社内品番 */
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** ファイル */
    fileId: text("file_id").notNull(), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** 写真の種類 */
    kind: text("kind", { enum: ["main", "detail", "reference", "ok_sample", "ng_sample"] })
      .notNull()
      .default("main"),
    /** 説明 */
    caption: text("caption"),
    /** 並び順 */
    sortKey: integer("sort_key").notNull().default(0),
  },
  (t) => [index("item_photos_file_id_idx").on(t.fileId)],
);

export type ItemPhotosRow = typeof itemPhotos.$inferSelect;
export type NewItemPhotosRow = typeof itemPhotos.$inferInsert;
