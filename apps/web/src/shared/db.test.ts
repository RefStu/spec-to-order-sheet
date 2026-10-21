import { describe, expect, it } from "vitest";
import { chunkForD1, D1_MAX_BOUND_PARAMS, insertInChunks } from "./db";

/**
 * ⚠⚠ 通しの確認で実際に起きた壊れ方を固定する。
 *   3 明細の発注書 = `ai_extraction_fields` 26 行 × 12 列 = 312 個の bind 変数 →
 *   `D1_ERROR: too many SQL variables` → consumer が retry → 同じ帳票が 3 回読まれて DLQ。
 */
const row = (columns: number) =>
  Object.fromEntries(Array.from({ length: columns }, (_, i) => [`c${i}`, i]));

describe("chunkForD1", () => {
  it("1 文あたりの bind 変数が上限を超えない", () => {
    const rows = Array.from({ length: 26 }, () => row(12));
    const chunks = chunkForD1(rows);

    expect(chunks.flat()).toHaveLength(26);
    for (const chunk of chunks) {
      expect(chunk.length * 12).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });

  it("収まるなら 1 文のまま (無駄に分けない)", () => {
    expect(chunkForD1(Array.from({ length: 5 }, () => row(5)))).toHaveLength(1);
  });

  it("空なら 1 文も投げない", () => {
    expect(chunkForD1([])).toEqual([]);
  });

  it("列が上限より多くても 1 行ずつ投げる (0 で割らない)", () => {
    const chunks = chunkForD1([row(120), row(120)]);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length === 1)).toBe(true);
  });

  it("列数は行ごとのキーの多いほうで測る (drizzle は union で ? を並べる)", () => {
    const chunks = chunkForD1([row(2), row(50)]);
    expect(chunks.every((chunk) => chunk.length * 50 <= D1_MAX_BOUND_PARAMS)).toBe(true);
  });

  it("順番を保つ", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...row(12), i }));
    expect(
      chunkForD1(rows)
        .flat()
        .map((r) => r.i),
    ).toEqual(rows.map((r) => r.i));
  });
});

describe("insertInChunks", () => {
  it("分けた数だけ呼ぶ", async () => {
    const seen: number[] = [];
    await insertInChunks(
      Array.from({ length: 26 }, () => row(12)),
      async (chunk) => {
        seen.push(chunk.length);
      },
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(26);
  });

  it("空なら 1 度も呼ばない", async () => {
    let calls = 0;
    await insertInChunks([], async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });
});
