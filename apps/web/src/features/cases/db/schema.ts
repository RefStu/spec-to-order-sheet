// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/cases/db/schema.ts
// この feature: 案件
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   このリポジトリの ESLint（boundaries）が feature 間の import を禁止しているため。
//   参照先があるかはアプリ側で確かめる。

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 案件 — ORDER SHEET 1 枚がカバーする単位 */
export const cases = sqliteTable(
  "cases",
  {
    /** 案件ID */
    id: text("id").primaryKey(),
    /** 案件番号(このアプリでは採番しない) */
    caseNo: text("case_no").unique(),
    /** 取引先 */
    partnerId: text("partner_id").notNull(), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** 案件名(画面の一覧に出す見出し) */
    title: text("title"),
    /** 仕様書No(製造番号。発注書・依頼書・ORDER SHEET を繋ぐ鍵) */
    specNo: text("spec_no"),
    /** 状態 */
    status: text("status", { enum: ["open", "closed", "cancelled"] })
      .notNull()
      .default("open"),
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
    index("cases_partner_idx").on(t.partnerId, t.status),
    index("cases_spec_no_idx").on(t.specNo),
    index("cases_partner_id_idx").on(t.partnerId),
  ],
);

export type CasesRow = typeof cases.$inferSelect;
export type NewCasesRow = typeof cases.$inferInsert;
