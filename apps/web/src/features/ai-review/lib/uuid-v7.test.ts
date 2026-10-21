import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid-v7";

describe("uuidv7", () => {
  it("UUID の形で、version が 7・variant が 10 になる", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("時刻が先頭に入るので、時刻順に並べると文字列順と一致する", () => {
    // ⚠ これが v4 ではなく v7 を使う理由の 1 つ (索引の局所性)。
    const older = uuidv7(1_600_000_000_000);
    const newer = uuidv7(1_700_000_000_000);
    expect(older < newer).toBe(true);
  });

  it("同じミリ秒でも衝突しない (乱数部が 74 bit ある)", () => {
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7(1_700_000_000_000)));
    expect(ids.size).toBe(500);
  });

  it("先頭 48 bit がそのミリ秒になっている", () => {
    const ms = 0x018f_1234_5678;
    const id = uuidv7(ms);
    expect(id.replace(/-/g, "").slice(0, 12)).toBe(ms.toString(16).padStart(12, "0"));
  });
});
