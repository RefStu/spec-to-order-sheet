import { describe, expect, it } from "vitest";
import { progressSchema } from "./schema";

/**
 * ★ 取り込みの進み具合の語彙を固定する。
 *
 * ⚠⚠ **同じ語彙が `features/files/schema.ts` の `uploadResult.status` にもある。**
 *   ESLint の boundaries が feature 間の import を `import type` でも禁じているので、
 *   1 本のテストで突き合わせることはできない。**両方に同じリテラルを置いて、
 *   片方を変えたらその feature 自身のテストが落ちるようにしてある。**
 *   ここが落ちたら `apps/web/src/features/files/schema.ts` も見ること。
 */
describe("progressSchema — 進み具合の語彙", () => {
  it("accepted / reading / written / failed の 4 つだけ", () => {
    expect(progressSchema.options).toEqual(["accepted", "reading", "written", "failed"]);
  });

  it("知らない語は受け付けない", () => {
    expect(progressSchema.safeParse("done").success).toBe(false);
  });
});
