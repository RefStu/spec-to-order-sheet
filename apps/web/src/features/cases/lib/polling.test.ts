import { describe, expect, it } from "vitest";
import { backoffMs, JOB_POLL_MS, LIST_POLL_MS } from "./polling";

describe("backoffMs", () => {
  it("回を追うごとに伸びる", () => {
    const seen = LIST_POLL_MS.map((_, i) => backoffMs(i, LIST_POLL_MS));
    expect(seen).toEqual([...LIST_POLL_MS]);
    expect(seen.every((ms, i) => i === 0 || ms > seen[i - 1]!)).toBe(true);
  });

  it("表の末尾で頭打ちになる (諦めない)", () => {
    expect(backoffMs(99, LIST_POLL_MS)).toBe(20_000);
    expect(backoffMs(99, JOB_POLL_MS)).toBe(15_000);
  });

  it("負の回でも先頭を返す", () => {
    expect(backoffMs(-1, JOB_POLL_MS)).toBe(2_000);
  });

  /** ⚠ ジョブ 1 件を追うほうが軽いので、一覧より短く始める。 */
  it("ジョブの追跡は一覧より細かく始める", () => {
    expect(JOB_POLL_MS[0]).toBeLessThan(LIST_POLL_MS[0]);
  });
});
