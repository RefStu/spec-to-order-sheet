// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/files/db/schema.ts
// この feature: ファイル
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   このリポジトリの ESLint（boundaries）が feature 間の import を禁止しているため。
//   参照先があるかはアプリ側で確かめる。

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** ファイル — 受け取った発注書、商品写真、帳票の PDF。実体は R2 で、ここはその参照 */
export const files = sqliteTable(
  "files",
  {
    /** ファイルID */
    id: text("id").primaryKey(),
    /** 用途 */
    kind: text("kind", {
      enum: [
        "customer_po",
        "spec_sheet",
        "order_sheet_pdf",
        // ⚠ 後から足したもの。エクスポートした ORDER SHEET の実体。
        "order_sheet_xlsx",
        "revision_request_pdf",
        "item_photo",
        "reference",
        "form_sample",
        "attachment",
      ],
    }).notNull(),
    /** 保存先のキー(R2 のオブジェクトキー) */
    storageKey: text("storage_key").notNull().unique(),
    /** 元のファイル名 */
    originalFilename: text("original_filename").notNull(),
    /** MIMEタイプ */
    contentType: text("content_type").notNull(),
    /** バイト数 */
    byteSize: integer("byte_size").notNull(),
    /** ページ数(PDF のとき) */
    pageCount: integer("page_count"),
    /** 内容のハッシュ(同じ発注書の二重取り込みを防ぐ) */
    sha256: text("sha256").notNull(),
    /** どう受け取ったか */
    receivedVia: text("received_via", { enum: ["upload", "email", "fax", "portal", "generated"] })
      .notNull()
      .default("upload"),
    /** 取り込んだ人(自動なら空) */
    uploadedBy: text("uploaded_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 取り込み日時 */
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull(),
    /** 論理削除した日時 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("files_kind_idx").on(t.kind, t.uploadedAt),
    index("files_sha_idx").on(t.sha256),
    index("files_uploaded_by_idx").on(t.uploadedBy),
  ],
);

export type FilesRow = typeof files.$inferSelect;
export type NewFilesRow = typeof files.$inferInsert;

/** ファイルのページ — PDF の 1 ページ。AI が読んだ生テキストと、画面で原本を見せるための画像を持つ */
export const filePages = sqliteTable(
  "file_pages",
  {
    /** ページID */
    id: text("id").primaryKey(),
    /** ファイル */
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** ページ番号(1から) */
    pageNo: integer("page_no").notNull(),
    /** ページ画像の保存先キー */
    imageStorageKey: text("image_storage_key"),
    /** 画像の幅 */
    widthPx: integer("width_px"),
    /** 画像の高さ */
    heightPx: integer("height_px"),
    /** 抽出した生テキスト */
    extractedText: text("extracted_text"),
    /** 文字の座標などの構造(抽出結果の裏取りに使う) */
    layoutJson: text("layout_json"),
  },
  (t) => [uniqueIndex("file_pages_no_idx").on(t.fileId, t.pageNo)],
);

export type FilePagesRow = typeof filePages.$inferSelect;
export type NewFilePagesRow = typeof filePages.$inferInsert;
