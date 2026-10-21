import { z } from "zod";

/**
 * 帳票の種類 (`po_documents.doc_kind` と同じ値)。
 *
 * ⚠⚠ **アップロードのときには決まらない。** 実物は 1 つの PDF に発注書と依頼書が
 *   内包されて届くので、何が入っているかは**読んで初めて分かる** (`unknown` → `mixed` など)。
 *   人に選ばせる口は作らない。
 */
export const docKind = z.enum(["purchase_order", "spec_sheet", "mixed", "unknown"]);
export type DocKind = z.infer<typeof docKind>;

/**
 * 受け付ける形式。**ここが唯一の正。**
 *
 * ⚠ 受け口 (`upload-service.ts`)・画面の `<input accept>`・ai へ渡す `mediaType` は
 *   **すべてこの集合だけを見る**。種類を増やすときは、ここに 1 行足して
 *   ai 側の指示文を直すだけで済むようにしてある。
 * ⚠ いまは PDF だけ (実物がスキャン PDF のため)。画像や xlsx は次の段階。
 */
export const ACCEPTED_CONTENT_TYPES = ["application/pdf"] as const;
export type AcceptedContentType = (typeof ACCEPTED_CONTENT_TYPES)[number];

export function isAcceptedContentType(value: string): value is AcceptedContentType {
  return (ACCEPTED_CONTENT_TYPES as readonly string[]).includes(value);
}

/** @deprecated `ACCEPTED_CONTENT_TYPES` を見ること。保存のときの既定値としてだけ残す。 */
export const PDF_CONTENT_TYPE = "application/pdf";

/**
 * 受け付ける上限。
 * ⚠ 読み取りのとき **base64 にして JSON に埋めて** Cloud Run へ送る (ai-client は
 *   JSON しか送れない) ので、実際に載る量は 4/3 倍になる。ここを上げるときはその前提で。
 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * アップロードのフォーム。multipart なので zValidator は使えず、ルートが手で検証する。
 * ⚠ **種類は受け取らない** (上の `docKind` の注記)。
 */
export const uploadFormFields = z.object({
  /** 帳票を足す先の案件。未指定なら新しく起こす。 */
  caseId: z.string().min(1).optional(),
});

/** アップロードの受け口。PoC は発注書と依頼書の PDF だけ。 */
export const uploadResult = z.object({
  fileId: z.string(),
  /** 届いた帳票がそのまま起こす案件。 */
  caseId: z.string(),
  /** 読み取りのジョブ。進み具合はこれで引く。 */
  jobId: z.string(),
  status: z.enum(["accepted", "reading", "written", "failed"]),
});
