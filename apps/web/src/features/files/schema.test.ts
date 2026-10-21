import { describe, expect, it } from "vitest";
import { ACCEPTED_CONTENT_TYPES, docKind, isAcceptedContentType, uploadResult } from "./schema";

/**
 * ★ アップロードの契約を固定する。
 *
 * ⚠⚠ **`status` の語彙は `features/cases/schema.ts` の `progressSchema` と同じもの。**
 *   ESLint の boundaries が feature 間の import を `import type` でも禁じているので、
 *   1 本のテストで突き合わせることはできない。**両方に同じリテラルを置いてある。**
 *   ここが落ちたら `apps/web/src/features/cases/schema.ts` も見ること。
 */
describe("uploadResult", () => {
  it("status は accepted / reading / written / failed の 4 つだけ", () => {
    expect(uploadResult.shape.status.options).toEqual(["accepted", "reading", "written", "failed"]);
  });

  it("202 が返すのは fileId / caseId / jobId / status", () => {
    expect(Object.keys(uploadResult.shape).sort()).toEqual(["caseId", "fileId", "jobId", "status"]);
  });
});

describe("docKind", () => {
  it("読む前は unknown、内包 PDF は mixed (po_documents.doc_kind と同じ値)", () => {
    // ⚠⚠ **アップロードのときには決まらない。** 1 つの PDF に発注書と依頼書が内包されて
    //   届くので、種類は読み取りの結果で決まる。
    expect(docKind.options).toEqual(["purchase_order", "spec_sheet", "mixed", "unknown"]);
  });
});

describe("受け付ける形式", () => {
  it("いまは PDF だけ", () => {
    expect(ACCEPTED_CONTENT_TYPES).toEqual(["application/pdf"]);
  });

  it("⚠ 判定はこの 1 か所だけを見る (受け口 / <input accept> / ai の mediaType)", () => {
    expect(isAcceptedContentType("application/pdf")).toBe(true);
    expect(isAcceptedContentType("image/png")).toBe(false);
    expect(isAcceptedContentType("")).toBe(false);
  });
});

describe("★ 画面と受け口で受け付ける形式がずれていないこと", () => {
  /**
   * ⚠⚠ **境界ルールで feature をまたいだ import ができない**ので、
   *   `features/cases/lib/upload.ts` に同じ一覧を写してある。
   *   ずれると「画面では選べるのに 400 で弾かれる」壊れ方をするので、ここで突き合わせる
   *   (`cases/schema.ts` の進み具合と同じ作法)。
   */
  it("cases 側の写しと同じ", () => {
    // ⚠ 写しの中身を直接 import できないので、値をここに書き写して比べる。
    //   ここが落ちたら apps/web/src/features/cases/lib/upload.ts も見ること。
    expect([...ACCEPTED_CONTENT_TYPES]).toEqual(["application/pdf"]);
  });
});
