// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/accounts/db/schema.ts
// この feature: 利用者
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   ESLint が feature 間の import を禁止しているため。
//   孤児の検出は持っていない。

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 利用者 — 社内の担当者。プランニング・営業・製造・品質・承認者を役割で分ける */
export const users = sqliteTable("users", {
  /** 利用者ID */
  id: text("id").primaryKey(),
  /** 社員コード */
  code: text("code").notNull().unique(),
  /** 氏名 */
  name: text("name").notNull(),
  /** 英字表記(帳票への印字に使う) */
  nameEn: text("name_en"),
  /** メールアドレス */
  email: text("email").notNull().unique(),
  /** 部門 */
  department: text("department", {
    enum: ["planning", "sales", "production", "quality", "admin"],
  }).notNull(),
  /** 所属拠点 */
  site: text("site", { enum: ["japan", "factory"] }).notNull(),
  /** 画面の言語 */
  locale: text("locale", { enum: ["ja", "th", "en"] })
    .notNull()
    .default("ja"),
  /** ORDER SHEET を承認できるか */
  canApproveOrderSheet: integer("can_approve_order_sheet", { mode: "boolean" })
    .notNull()
    .default(false),
  /** 変更修正依頼書を承認できるか */
  canApproveRevision: integer("can_approve_revision", { mode: "boolean" }).notNull().default(false),
  /** 在籍中かどうか */
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  /** 登録日時 */
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** 更新日時 */
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  /** 論理削除した日時 */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
});

export type UsersRow = typeof users.$inferSelect;
export type NewUsersRow = typeof users.$inferInsert;
