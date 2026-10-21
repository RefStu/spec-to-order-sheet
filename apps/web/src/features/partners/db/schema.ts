// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/partners/db/schema.ts
// この feature: 取引先
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   ESLint が feature 間の import を禁止しているため。
//   孤児の検出は持っていない。

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 取引先 — 発注書を送ってくるお客様。様式が会社ごとに違うので、その定義もぶら下げる */
export const partners = sqliteTable("partners", {
  /** 取引先ID */
  id: text("id").primaryKey(),
  /** 社内の取引先コード */
  code: text("code").notNull().unique(),
  /** 取引先名 */
  name: text("name").notNull(),
  /** 英字表記(ORDER SHEET に印字する) */
  nameEn: text("name_en"),
  /** 帳票の見出しに使う短い表示名 */
  shortName: text("short_name").notNull(),
  /** 国コード */
  country: text("country").notNull().default("JP"),
  /** 住所 */
  address: text("address"),
  /** 電話番号 */
  tel: text("tel"),
  /** FAX番号 */
  fax: text("fax"),
  /** 金額が税抜か税込か */
  taxMode: text("tax_mode", { enum: ["excluded", "included", "exempt"] })
    .notNull()
    .default("excluded"),
  /** 標準の製造リードタイム(日) */
  defaultLeadTimeDays: integer("default_lead_time_days"),
  /** ORDER SHEET に出す見出し(発注番号の呼び方が会社で違う) */
  poNoLabel: text("po_no_label", { enum: ["customer_po", "customer_no"] })
    .notNull()
    .default("customer_po"),
  /** 発注番号の形(正規表現。AI の抽出の裏取りに使う) */
  poNoPattern: text("po_no_pattern"),
  /** 検査完了期日(納入後 n 日以内) */
  inspectionDueDays: integer("inspection_due_days"),
  /** AI の自動確定を許す確信度(0-100。空なら全社の既定値) */
  autoApplyThreshold: integer("auto_apply_threshold"),
  /** 取引中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  /** 登録日時 */
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** 更新日時 */
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  /** 論理削除した日時 */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
});

export type PartnersRow = typeof partners.$inferSelect;
export type NewPartnersRow = typeof partners.$inferInsert;

/** 帳票の様式 — お客様から届く発注書と依頼書の原紙。取引先 × 品目 × 製法で様式が分かれる */
export const partnerFormProfiles = sqliteTable(
  "partner_form_profiles",
  {
    /** 様式ID */
    id: text("id").primaryKey(),
    /** 取引先(空なら取引先によらない自社の様式) */
    partnerId: text("partner_id").references(() => partners.id, { onDelete: "cascade" }),
    /** 様式コード(様式パターン① など) */
    code: text("code").notNull(),
    /** 様式の名前 */
    name: text("name").notNull(),
    /** 発注書の様式か、依頼書の原紙の様式か */
    // ⚠ `mixed` は後から足したもの (po_documents.doc_kind と同じ)。
    //   発注書と依頼書が内包された 1 つの PDF を 1 つの様式として扱うため。
    docKind: text("doc_kind", { enum: ["purchase_order", "spec_sheet", "mixed"] })
      .notNull()
      .default("purchase_order"),
    /** 対象の品目種別(空ならすべて。items.category と同じ値) */
    itemCategory: text("item_category", {
      enum: ["ring", "earring", "necklace", "bracelet", "pendant", "object", "other"],
    }),
    /** 対象の製法(空ならすべて) */
    productionMethod: text("production_method", {
      enum: ["cast", "cnc", "handmade", "combination", "other"],
    }),
    /** 受け取る形 */
    media: text("media", { enum: ["pdf", "excel", "image", "email_body", "portal"] })
      .notNull()
      .default("pdf"),
    /** 発注区分ごとに番号と納期が分かれる様式か */
    hasOrderGroups: integer("has_order_groups", { mode: "boolean" }).notNull().default(false),
    /** サイズ別の製作数量表を持つ様式か */
    hasSizeBreakdown: integer("has_size_breakdown", { mode: "boolean" }).notNull().default(false),
    /** メレの刻み別ピース数を持つ様式か */
    hasStoneBreakdown: integer("has_stone_breakdown", { mode: "boolean" }).notNull().default(false),
    /** AI にこの様式の読み方を教える補足(プロンプトに差し込む) */
    extractionHint: text("extraction_hint"),
    /** 様式の見本ファイル(PoC では使わない。原本を保存しないため) */
    sampleFileId: text("sample_file_id"), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** 様式の版(先方が書式を変えたら上げる) */
    version: integer("version").notNull().default(1),
    /** この版が有効になった日 */
    validFrom: text("valid_from"),
    /** 使用中かどうか */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /** 登録日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("partner_form_profiles_code_idx").on(t.partnerId, t.code, t.version),
    index("partner_form_profiles_kind_idx").on(t.docKind, t.itemCategory, t.productionMethod),
    index("partner_form_profiles_sample_file_id_idx").on(t.sampleFileId),
  ],
);

export type PartnerFormProfilesRow = typeof partnerFormProfiles.$inferSelect;
export type NewPartnerFormProfilesRow = typeof partnerFormProfiles.$inferInsert;

/** 様式の見本から取った特徴 — 見本の発注書から抜いた様式の特徴だけを残す。原本と値は保存しない(顧客情報を残さないため) */
export const partnerFormSamples = sqliteTable(
  "partner_form_samples",
  {
    /** 特徴ID */
    id: text("id").primaryKey(),
    /** どの様式の見本か */
    formProfileId: text("form_profile_id")
      .notNull()
      .references(() => partnerFormProfiles.id, { onDelete: "cascade" }),
    /** 見出し語の一覧(項目名だけ。値は入れない) */
    headingsJson: text("headings_json").notNull(),
    /** 表の列構成と項目の相対位置(値は入れない) */
    layoutJson: text("layout_json").notNull(),
    /** 見本のページ数 */
    pageCount: integer("page_count").notNull(),
    /** 見本ファイルのハッシュ(同じ見本の二重登録を防ぐ。原本そのものは保存しない) */
    sourceSha256: text("source_sha256"),
    /** 取り込んだ人 */
    extractedBy: text("extracted_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 特徴を抽出した日時 */
    extractedAt: integer("extracted_at", { mode: "timestamp_ms" }).notNull(),
    /** この日を過ぎたら消す(保存期間) */
    retentionUntil: text("retention_until"),
    /** 論理削除した日時 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("partner_form_samples_profile_idx").on(t.formProfileId),
    index("partner_form_samples_sha_idx").on(t.sourceSha256),
    index("partner_form_samples_extracted_by_idx").on(t.extractedBy),
  ],
);

export type PartnerFormSamplesRow = typeof partnerFormSamples.$inferSelect;
export type NewPartnerFormSamplesRow = typeof partnerFormSamples.$inferInsert;
