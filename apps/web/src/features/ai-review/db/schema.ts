// D1 のテーブル定義 (Drizzle)。
// テーブルを変えたら make db-generate で migration を作る。
// 想定: drizzle-orm >= 0.36
// 置き先: apps/web/src/features/ai-review/db/schema.ts
// この feature: AI 処理とレビュー
//
// ⚠ feature をまたぐ外部キーは張っていない(ID だけを持つソフト参照)。
//   ESLint が feature 間の import を禁止しているため。
//   孤児の検出は持っていない。

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** AI ジョブ — Queue に積んで Cloud Run 側で処理する 1 単位 */
export const aiJobs = sqliteTable(
  "ai_jobs",
  {
    /** ジョブID */
    id: text("id").primaryKey(),
    /**
     * 何をするジョブか
     *
     * ⚠⚠ **`doc_extract` は後から足したもの**(case_id と同じ扱い)。
     *   1 つの PDF に発注書と依頼書が内包されるので、**帳票 1 通 = ジョブ 1 件**にした。
     *   ⚠ `po_extract` / `spec_sheet_extract` は**消さない**(積まれたままのジョブが通るように)。
     *     新しく積むのは `doc_extract` だけ。
     */
    jobType: text("job_type", {
      enum: [
        "doc_extract",
        "po_extract",
        "spec_sheet_extract",
        "item_resolve",
        "order_sheet_generate",
        "alias_embed",
        "translate_remark",
      ],
    }).notNull(),
    /** 状態 */
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "needs_review", "cancelled"],
    })
      .notNull()
      .default("queued"),
    /** 対象の種類 */
    targetKind: text("target_kind", {
      enum: [
        "po_document",
        "purchase_order",
        "purchase_order_line",
        "order_sheet",
        "revision_request",
        "alias",
      ],
    }).notNull(),
    /** 対象のID(種類で参照先が変わるのでソフト参照) */
    targetId: text("target_id").notNull(),
    /**
     * ★ どの案件のジョブか。
     *
     * ⚠⚠ **この 1 列は後から足した。** 案件からジョブへ辿る経路が
     *   他に無いため (po_documents に case_id が無く、caseId はキューのメッセージの中にしか
     *   居なかった)。案件一覧の「進み具合」の列がこれを読む。
     * ⚠ ソフト参照 -> cases.id。feature をまたぐので references は付けない。
     * ⚠ nullable。この列を足す前に積まれたジョブが残っているため。
     */
    caseId: text("case_id"),
    /** 入力ファイル */
    inputFileId: text("input_file_id"), // ソフト参照 -> files.id(feature をまたぐので references は付けない)
    /** 使ったプロンプト */
    promptId: text("prompt_id").references(() => aiPrompts.id),
    /** 使ったモデル */
    modelName: text("model_name"),
    /** 何回目の試行か */
    attempt: integer("attempt").notNull().default(1),
    /** 入力トークン数 */
    inputTokens: integer("input_tokens"),
    /** 出力トークン数 */
    outputTokens: integer("output_tokens"),
    /** 費用(通貨の最小単位の 1/1000000) */
    costMicro: integer("cost_micro"),
    /** 所要時間(ミリ秒) */
    latencyMs: integer("latency_ms"),
    /** 観測基盤のトレースID(後から追えるように) */
    traceId: text("trace_id"),
    /** 失敗の理由 */
    errorMessage: text("error_message"),
    /**
     * ★★ 読み取りの**段の進み具合** (JSON)。**画面のポーリングが読む唯一の場所。**
     *
     * ⚠⚠ **後から足した 2 列目** (`case_id` と同じ扱い)。
     * ⚠ 中身は `{ nodes: { <node>: { label, stage, status, at } } }`。
     *   読む側は `cases/lib/progress.ts` の `parseProgressNodes`。
     * ⚠⚠ **ここを Mastra の snapshot で置き換えられない。** web には Turso への口が無い
     *   (`webEnvSchema` に `LIBSQL_URL` が無く、wrangler の binding にも無い)。
     * ⚠ nullable。進捗を流さない経路 (戻り道の JSON ルート / 古いジョブ) では空のまま。
     */
    progressJson: text("progress_json"),
    /** 投入日時 */
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
    /** 開始日時 */
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    /** 終了日時 */
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("ai_jobs_status_idx").on(t.status, t.queuedAt),
    index("ai_jobs_target_idx").on(t.targetKind, t.targetId),
    index("ai_jobs_input_file_id_idx").on(t.inputFileId),
    // 案件の最新ジョブを引く (案件一覧の進み具合)。
    index("ai_jobs_case_idx").on(t.caseId, t.queuedAt),
  ],
);

export type AiJobsRow = typeof aiJobs.$inferSelect;
export type NewAiJobsRow = typeof aiJobs.$inferInsert;

/** 抽出の単位 — 1 回の読み取りの結果。帳票 1 通に対して版を重ねられる(プロンプトを変えて読み直すため) */
export const aiExtractions = sqliteTable(
  "ai_extractions",
  {
    /** 抽出ID */
    id: text("id").primaryKey(),
    /** ジョブ */
    aiJobId: text("ai_job_id")
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    /** 読んだ原本 */
    poDocumentId: text("po_document_id"), // ソフト参照 -> po_documents.id(feature をまたぐので references は付けない)
    /** 版(読み直すたびに上げる) */
    version: integer("version").notNull().default(1),
    /** 今採用している版かどうか */
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    /** 抽出したフィールド数 */
    fieldCount: integer("field_count").notNull().default(0),
    /** 確信度が閾値未満だったフィールド数 */
    lowConfidenceCount: integer("low_confidence_count").notNull().default(0),
    /** 全体の確からしさ(0-100) */
    overallConfidence: integer("overall_confidence"),
    /** 作成日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("ai_extractions_document_idx").on(t.poDocumentId, t.version),
    index("ai_extractions_po_document_id_idx").on(t.poDocumentId),
  ],
);

export type AiExtractionsRow = typeof aiExtractions.$inferSelect;
export type NewAiExtractionsRow = typeof aiExtractions.$inferInsert;

/** 抽出の生出力 — モデルが返した JSON をそのまま保存する。大きいので本体とは別の表に置く */
export const aiExtractionPayloads = sqliteTable("ai_extraction_payloads", {
  /** 生出力ID */
  id: text("id").primaryKey(),
  /** 抽出 */
  aiExtractionId: text("ai_extraction_id")
    .notNull()
    .references(() => aiExtractions.id, { onDelete: "cascade" }),
  /** モデルの出力そのまま */
  rawOutput: text("raw_output").notNull(),
  /** 実際に送ったプロンプト(再現のため) */
  promptSnapshot: text("prompt_snapshot"),
  /** 作成日時 */
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type AiExtractionPayloadsRow = typeof aiExtractionPayloads.$inferSelect;
export type NewAiExtractionPayloadsRow = typeof aiExtractionPayloads.$inferInsert;

/** 抽出したフィールド — ★フィールド 1 つ = 1 行。確信度と原本上の位置を持つ。1 年で数百万行になるので古い行は R2 に退避する */
export const aiExtractionFields = sqliteTable(
  "ai_extraction_fields",
  {
    /** フィールドID */
    id: text("id").primaryKey(),
    /** 抽出 */
    aiExtractionId: text("ai_extraction_id")
      .notNull()
      .references(() => aiExtractions.id, { onDelete: "cascade" }),
    /** 書き込み先のテーブル名 */
    targetTable: text("target_table").notNull(),
    /** 書き込み先の行ID(UUIDv7 を先に決めるので INSERT 前に埋まる) */
    targetRowId: text("target_row_id"),
    /** 書き込み先の列名 */
    targetColumn: text("target_column").notNull(),
    /** 帳票から読んだ文字列 */
    rawValue: text("raw_value"),
    /** 正規化・型変換した後の値 */
    normalizedValue: text("normalized_value"),
    /** 確からしさ(0-100) */
    confidence: integer("confidence").notNull(),
    /** 人の確認が要るか */
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
    /** 原本の何ページ目か */
    pageNo: integer("page_no"),
    /** 原本上の位置(画面で該当箇所を光らせる) */
    bboxJson: text("bbox_json"),
    /** 作成日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("ai_extraction_fields_review_idx").on(t.aiExtractionId, t.needsReview),
    index("ai_extraction_fields_target_idx").on(t.targetTable, t.targetRowId),
  ],
);

export type AiExtractionFieldsRow = typeof aiExtractionFields.$inferSelect;
export type NewAiExtractionFieldsRow = typeof aiExtractionFields.$inferInsert;

/** 人の修正 — ★AI の読み違いを人が直した記録。精度改善の教材になるので必ず残す */
export const aiFieldCorrections = sqliteTable(
  "ai_field_corrections",
  {
    /** 修正ID */
    id: text("id").primaryKey(),
    /** 直したフィールド */
    aiExtractionFieldId: text("ai_extraction_field_id").references(() => aiExtractionFields.id),
    /** ジョブ */
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    /** 対象のテーブル名 */
    targetTable: text("target_table").notNull(),
    /** 対象の行ID */
    targetRowId: text("target_row_id"),
    /** 対象の列名 */
    targetColumn: text("target_column").notNull(),
    /** AI の出した値 */
    beforeValue: text("before_value"),
    /** 人が入れ直した値 */
    afterValue: text("after_value"),
    /** 誤りの種類(どこを直せば減るかを分類する) */
    errorKind: text("error_kind", {
      enum: ["ocr", "mapping", "unit", "date", "missing", "hallucination", "other"],
    }).notNull(),
    /** 直した人 */
    correctedBy: text("corrected_by").notNull(), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 修正日時 */
    correctedAt: integer("corrected_at", { mode: "timestamp_ms" }).notNull(),
    /** 補足 */
    note: text("note"),
  },
  (t) => [
    index("ai_field_corrections_kind_idx").on(t.errorKind, t.correctedAt),
    index("ai_field_corrections_corrected_by_idx").on(t.correctedBy),
  ],
);

export type AiFieldCorrectionsRow = typeof aiFieldCorrections.$inferSelect;
export type NewAiFieldCorrectionsRow = typeof aiFieldCorrections.$inferInsert;

/** レビュー待ち — 人が見る必要がある箇所だけを積む。全部を人が見る運用にしないための仕組み */
export const reviewTasks = sqliteTable(
  "review_tasks",
  {
    /** タスクID */
    id: text("id").primaryKey(),
    /** 何のレビューか */
    kind: text("kind", {
      enum: [
        "low_confidence_field",
        "unmatched_item",
        "ambiguous_alias",
        "amount_mismatch",
        "new_item",
        "form_unknown",
        "other",
      ],
    }).notNull(),
    /** 対象の種類 */
    targetKind: text("target_kind", {
      enum: [
        "po_document",
        "purchase_order",
        "purchase_order_line",
        "order_sheet",
        "order_sheet_line",
        "revision_request",
        "alias",
      ],
    }).notNull(),
    /** 対象のID(種類で参照先が変わるのでソフト参照) */
    targetId: text("target_id").notNull(),
    /** 取引先(担当者へ振り分けるため) */
    partnerId: text("partner_id"), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** 見出し */
    title: text("title").notNull(),
    /** 内容 */
    detail: text("detail"),
    /** 優先度 */
    priority: text("priority", { enum: ["low", "normal", "high"] })
      .notNull()
      .default("normal"),
    /** 状態 */
    status: text("status", { enum: ["open", "in_progress", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    /** 担当者 */
    assignedTo: text("assigned_to"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 解消した人 */
    resolvedBy: text("resolved_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 解消日時 */
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /** 作成日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("review_tasks_queue_idx").on(t.status, t.priority, t.createdAt),
    index("review_tasks_target_idx").on(t.targetKind, t.targetId),
    index("review_tasks_partner_id_idx").on(t.partnerId),
    index("review_tasks_assigned_to_idx").on(t.assignedTo),
    index("review_tasks_resolved_by_idx").on(t.resolvedBy),
  ],
);

export type ReviewTasksRow = typeof reviewTasks.$inferSelect;
export type NewReviewTasksRow = typeof reviewTasks.$inferInsert;

/** 承認 — 帳票ごとに承認の段が違い、差し戻しもあるので 1 枚にまとめる */
export const approvals = sqliteTable(
  "approvals",
  {
    /** 承認ID */
    id: text("id").primaryKey(),
    /** 何を承認するか */
    targetKind: text("target_kind", {
      enum: ["purchase_order", "order_sheet", "revision_request"],
    }).notNull(),
    /** 対象のID(種類で参照先が変わるのでソフト参照) */
    targetId: text("target_id").notNull(),
    /** 承認の段 */
    step: integer("step").notNull().default(1),
    /** 差し戻しを含めた回数 */
    round: integer("round").notNull().default(1),
    /** 判断 */
    decision: text("decision", { enum: ["pending", "approved", "rejected", "returned"] })
      .notNull()
      .default("pending"),
    /** 承認者 */
    approverId: text("approver_id"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** コメント(差し戻しの理由) */
    comment: text("comment"),
    /** 依頼日時 */
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    /** 判断日時 */
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("approvals_target_idx").on(t.targetKind, t.targetId, t.round),
    index("approvals_pending_idx").on(t.decision, t.requestedAt),
    index("approvals_approver_id_idx").on(t.approverId),
  ],
);

export type ApprovalsRow = typeof approvals.$inferSelect;
export type NewApprovalsRow = typeof approvals.$inferInsert;

/** プロンプト — 抽出・生成の指示文を版で持つ。精度が落ちたときに前の版へ戻せるようにする */
export const aiPrompts = sqliteTable(
  "ai_prompts",
  {
    /** プロンプトID */
    id: text("id").primaryKey(),
    /**
     * 用途
     *
     * ⚠⚠ **`doc_classify` は後から足したもの**。
     *   読み取りが「分類 → 発注書 → 依頼書」の 3 ノードになったので、
     *   **ノードごとに指示文を差し替えられる**ように用途を 1 つ増やした
     *   (`po_extract` / `spec_sheet_extract` がそのまま残りの 2 ノードに対応する)。
     */
    purpose: text("purpose", {
      enum: [
        "doc_classify",
        "po_extract",
        "spec_sheet_extract",
        "item_resolve",
        "order_sheet_generate",
        "translate_remark",
      ],
    }).notNull(),
    /** プロンプトの名前(画面の一覧に出す) */
    name: text("name").notNull(),
    /** 何をするプロンプトか */
    description: text("description"),
    /** 取引先専用ならその取引先 */
    partnerId: text("partner_id"), // ソフト参照 -> partners.id(feature をまたぐので references は付けない)
    /** 様式専用ならその様式 */
    formProfileId: text("form_profile_id"), // ソフト参照 -> partner_form_profiles.id(feature をまたぐので references は付けない)
    /** 版 */
    version: integer("version").notNull().default(1),
    /** 指示文の本体 */
    body: text("body").notNull(),
    /** 期待する出力の形(zod に対応づける) */
    outputSchemaJson: text("output_schema_json"),
    /** 前提にしているモデル */
    modelName: text("model_name"),
    /** 今使っている版かどうか */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    /** 作成者 */
    createdBy: text("created_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 作成日時 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新日時 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /** 更新した人 */
    updatedBy: text("updated_by"), // ソフト参照 -> users.id(feature をまたぐので references は付けない)
    /** 論理削除した日時 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("ai_prompts_version_idx").on(t.purpose, t.formProfileId, t.version),
    index("ai_prompts_partner_id_idx").on(t.partnerId),
    index("ai_prompts_form_profile_id_idx").on(t.formProfileId),
    index("ai_prompts_created_by_idx").on(t.createdBy),
    index("ai_prompts_updated_by_idx").on(t.updatedBy),
  ],
);

export type AiPromptsRow = typeof aiPrompts.$inferSelect;
export type NewAiPromptsRow = typeof aiPrompts.$inferInsert;
