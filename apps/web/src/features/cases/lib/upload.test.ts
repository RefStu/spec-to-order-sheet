import { describe, expect, it } from "vitest";
import { ACCEPT_ATTRIBUTE, ACCEPTED_CONTENT_TYPES } from "./upload";

/**
 * ⚠⚠ **受け口 (`features/files/schema.ts`) の写し。** 境界ルールで import できないので、
 *   同じ値をここでも固定する。ずれると「画面では選べるのに 400 で弾かれる」。
 *   ここが落ちたら `apps/web/src/features/files/schema.ts` も見ること。
 */
describe("受け付ける形式", () => {
  it("いまは PDF だけ", () => {
    expect([...ACCEPTED_CONTENT_TYPES]).toEqual(["application/pdf"]);
  });

  it("<input accept> に渡す文字列", () => {
    expect(ACCEPT_ATTRIBUTE).toBe("application/pdf");
  });
});
