import { describe, expect, it } from "vitest";
import { asDate, asInteger, asText } from "./coerce";

const field = (value: string | number | null) => ({
  value,
  quote: null,
  page: null,
  confidence: 90,
});

describe("asInteger", () => {
  it("数値はそのまま、文字列の数字も読む", () => {
    expect(asInteger(field(12))).toBe(12);
    expect(asInteger(field("12"))).toBe(12);
    expect(asInteger(field("1,200"))).toBe(1200);
    expect(asInteger(field("１２"))).toBe(12); // 全角
  });

  it("数にならないものは null (でっち上げの 0 を入れない)", () => {
    expect(asInteger(field("一式"))).toBeNull();
    expect(asInteger(field(null))).toBeNull();
  });
});

describe("asText", () => {
  it("前後の空白を落とし、空なら null", () => {
    expect(asText(field("  MFG-1 "))).toBe("MFG-1");
    expect(asText(field("   "))).toBeNull();
    expect(asText(field(null))).toBeNull();
  });
});

describe("asDate", () => {
  it("帳票にある書き方を YYYY-MM-DD に寄せる", () => {
    expect(asDate(field("2026-11-20"))).toBe("2026-11-20");
    expect(asDate(field("2026/11/20"))).toBe("2026-11-20");
    expect(asDate(field("2026/1/5"))).toBe("2026-01-05");
    expect(asDate(field("2026年11月20日"))).toBe("2026-11-20");
  });

  it("⚠ 読めない日付は null。直せないものを入れると日付の取り違えになる", () => {
    expect(asDate(field("11/20"))).toBeNull();
    expect(asDate(field("2026-13-01"))).toBeNull();
    expect(asDate(field("未定"))).toBeNull();
    expect(asDate(field(null))).toBeNull();
  });
});
