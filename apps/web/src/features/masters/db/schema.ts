// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/masters/db/schema.ts
// この feature: マスタ
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   ESLint が feature 間の import を禁止しているため。
//   孤児の検出は持っていない。

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 単位 — 数量の単位(帳票の Unit 欄) */
export const units = sqliteTable("units", {
  /** 単位コード(PCS / SET / CM / G) */
  code: text("code").primaryKey(),
  /** 日本語名 */
  nameJa: text("name_ja").notNull(),
  /** 英語名(帳票に印字する) */
  nameEn: text("name_en").notNull(),
  /** 長さの単位かどうか(CM など) */
  isLength: integer("is_length", { mode: "boolean" }).notNull().default(false),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type UnitsRow = typeof units.$inferSelect;
export type NewUnitsRow = typeof units.$inferInsert;

/** 地金 — K18YG / SV925 などの素材。帳票の Description と素材コード欄に出る */
export const materials = sqliteTable("materials", {
  /** 地金ID */
  id: text("id").primaryKey(),
  /** 地金コード(K18YG / SV925 / PT900) */
  code: text("code").notNull().unique(),
  /** 種別 */
  category: text("category", { enum: ["gold", "silver", "platinum", "brass", "other"] }).notNull(),
  /** 金の品位を10倍した整数(K18なら180) */
  karatX10: integer("karat_x10"),
  /** 色 */
  color: text("color", { enum: ["yellow", "white", "pink", "mix", "none"] })
    .notNull()
    .default("none"),
  /** 純度(千分率。SV925なら925) */
  purityPermille: integer("purity_permille"),
  /** 比重を1000倍した整数(重量見積もり用) */
  densityX1000: integer("density_x1000"),
  /** 帳票への印字名 */
  displayName: text("display_name").notNull(),
  /** 備考 */
  remark: text("remark"),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  /** 登録日時 */
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** 更新日時 */
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  /** 論理削除した日時 */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
});

export type MaterialsRow = typeof materials.$inferSelect;
export type NewMaterialsRow = typeof materials.$inferInsert;

/** メッキ — 帳票の Description に出るメッキ指定 */
export const platings = sqliteTable("platings", {
  /** メッキID */
  id: text("id").primaryKey(),
  /** メッキコード(RH/P など) */
  code: text("code").notNull().unique(),
  /** 日本語名 */
  nameJa: text("name_ja").notNull(),
  /** 帳票への印字名 */
  displayName: text("display_name").notNull(),
  /** メッキに使う金属 */
  baseMaterialId: text("base_material_id").references(() => materials.id),
  /** 厚み(1/100ミクロン) */
  thicknessMicronX100: integer("thickness_micron_x100"),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type PlatingsRow = typeof platings.$inferSelect;
export type NewPlatingsRow = typeof platings.$inferInsert;

/** 仕上げ — 研磨・テクスチャーの指定(ミラー / マット / ヘアラインなど) */
export const finishes = sqliteTable("finishes", {
  /** 仕上げID */
  id: text("id").primaryKey(),
  /** 仕上げコード */
  code: text("code").notNull().unique(),
  /** 日本語名 */
  nameJa: text("name_ja").notNull(),
  /** 帳票への印字名 */
  displayName: text("display_name").notNull(),
  /** 注意事項(模様が消えやすい等) */
  cautionJa: text("caution_ja"),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type FinishesRow = typeof finishes.$inferSelect;
export type NewFinishesRow = typeof finishes.$inferInsert;

/** 石の種類 — ダイヤ / 色石 / 合成石など */
export const stoneTypes = sqliteTable("stone_types", {
  /** 石種ID */
  id: text("id").primaryKey(),
  /** 石種コード */
  code: text("code").notNull().unique(),
  /** 日本語名 */
  nameJa: text("name_ja").notNull(),
  /** 帳票への印字名 */
  displayName: text("display_name").notNull(),
  /** ダイヤかどうか(メレの刻み管理に使う) */
  isDiamond: integer("is_diamond", { mode: "boolean" }).notNull().default(false),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type StoneTypesRow = typeof stoneTypes.$inferSelect;
export type NewStoneTypesRow = typeof stoneTypes.$inferInsert;

/** 石の形 — ラウンド / ペアシェイプなど */
export const stoneShapes = sqliteTable("stone_shapes", {
  /** 形状ID */
  id: text("id").primaryKey(),
  /** 形状コード(RD / PS / OV など) */
  code: text("code").notNull().unique(),
  /** 日本語名 */
  nameJa: text("name_ja").notNull(),
  /** 帳票への印字名 */
  displayName: text("display_name").notNull(),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type StoneShapesRow = typeof stoneShapes.$inferSelect;
export type NewStoneShapesRow = typeof stoneShapes.$inferInsert;

/** 石のサイズ — メレダイヤの刻み(1/10 〜 1/250)と mm 表記を 1 つの表で持つ */
export const stoneSizes = sqliteTable("stone_sizes", {
  /** サイズID */
  id: text("id").primaryKey(),
  /** 表記の種類 */
  notation: text("notation", { enum: ["fraction", "mm", "carat", "free"] }).notNull(),
  /** サイズコード(1/30 / 2.5mm など) */
  code: text("code").notNull().unique(),
  /** 帳票への印字 */
  displayText: text("display_text").notNull(),
  /** 1個あたりのカラット(1/1000) */
  caratX1000: integer("carat_x1000"),
  /** 直径(1/100 mm) */
  diameterMmX100: integer("diameter_mm_x100"),
  /** 画面と帳票での並び順 */
  sortKey: integer("sort_key").notNull(),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type StoneSizesRow = typeof stoneSizes.$inferSelect;
export type NewStoneSizesRow = typeof stoneSizes.$inferInsert;

/** 指輪のサイズ — 号数。サイズ別数量を縦持ちにするときの参照先 */
export const ringSizes = sqliteTable("ring_sizes", {
  /** サイズID */
  id: text("id").primaryKey(),
  /** サイズ体系 */
  standard: text("standard", { enum: ["jp", "us", "eu", "free"] })
    .notNull()
    .default("jp"),
  /** サイズコード(#11 など) */
  code: text("code").notNull().unique(),
  /** 帳票への印字 */
  displayText: text("display_text").notNull(),
  /** 並び順 */
  sortKey: integer("sort_key").notNull(),
  /** 内径(1/100 mm) */
  innerDiameterMmX100: integer("inner_diameter_mm_x100"),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type RingSizesRow = typeof ringSizes.$inferSelect;
export type NewRingSizesRow = typeof ringSizes.$inferInsert;

/** 工程 — PRODUCTION PLAN の 1 行になる工程。工程数は品目で変わるので固定しない */
export const processes = sqliteTable("processes", {
  /** 工程ID */
  id: text("id").primaryKey(),
  /** 工程コード(WAX / CASTING / FILING / SETTING / POLISHING / PLATING / FINAL_QC など) */
  code: text("code").notNull().unique(),
  /** 英語名(帳票に印字する) */
  nameEn: text("name_en").notNull(),
  /** 日本語名 */
  nameJa: text("name_ja").notNull(),
  /** 現場の言語での名前(現場の表示用) */
  nameTh: text("name_th"),
  /** 種別(製造 / 検査 / 物流の節目) */
  kind: text("kind", { enum: ["production", "inspection", "logistics"] })
    .notNull()
    .default("production"),
  /** 標準の並び順 */
  defaultSeq: integer("default_seq").notNull(),
  /** 標準所要日数 */
  defaultDurationDays: integer("default_duration_days").notNull().default(1),
  /** 外注工程かどうか */
  isOutsourced: integer("is_outsourced", { mode: "boolean" }).notNull().default(false),
  /** 使用中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type ProcessesRow = typeof processes.$inferSelect;
export type NewProcessesRow = typeof processes.$inferInsert;

/** 工程ルートの雛形 — 品目の種類ごとの標準工程。ORDER SHEET を作るときにここから実体をコピーする */
export const processRouteTemplates = sqliteTable(
  "process_route_templates",
  {
    /** 雛形ID */
    id: text("id").primaryKey(),
    /** 雛形コード */
    code: text("code").notNull().unique(),
    /** 名称(指輪の標準 / レーザー刻印ありなど) */
    nameJa: text("name_ja").notNull(),
    /** 対象の品目種別 */
    itemCategory: text("item_category", {
      enum: ["ring", "earring", "necklace", "bracelet", "pendant", "object", "other"],
    }),
    /** 特定の取引先専用ならその取引先 */
    partnerId: text("partner_id"), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** 標準の総日数(出荷日からの逆算に使う) */
    totalDays: integer("total_days"),
    /** 既定の雛形かどうか */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** 使用中かどうか */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("process_route_templates_partner_id_idx").on(t.partnerId)],
);

export type ProcessRouteTemplatesRow = typeof processRouteTemplates.$inferSelect;
export type NewProcessRouteTemplatesRow = typeof processRouteTemplates.$inferInsert;

/** 工程ルートの明細 — 雛形 1 つに対する工程の並びと標準日数 */
export const processRouteSteps = sqliteTable(
  "process_route_steps",
  {
    /** 明細ID */
    id: text("id").primaryKey(),
    /** 雛形 */
    templateId: text("template_id")
      .notNull()
      .references(() => processRouteTemplates.id, { onDelete: "cascade" }),
    /** 工程 */
    processId: text("process_id")
      .notNull()
      .references(() => processes.id),
    /** 並び順 */
    seq: integer("seq").notNull(),
    /** 所要日数 */
    durationDays: integer("duration_days").notNull(),
    /** 省略されることがある工程か */
    isOptional: integer("is_optional", { mode: "boolean" }).notNull().default(false),
    /** 備考 */
    note: text("note"),
  },
  (t) => [uniqueIndex("process_route_steps_seq_idx").on(t.templateId, t.seq)],
);

export type ProcessRouteStepsRow = typeof processRouteSteps.$inferSelect;
export type NewProcessRouteStepsRow = typeof processRouteSteps.$inferInsert;
