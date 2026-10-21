import { describe, expect, it } from "vitest";
import { formatSizeText } from "./size-text";

/**
 * ★ 実物の ORDER SHEET は指輪の号数が `#10`（発注書の印字は `10`）。
 * ⚠⚠ 確かめられたのは**号数 1 件だけ**なので、数字だけの印字に絞ってある。
 */
describe("formatSizeText — Size 欄", () => {
  it("★ 数字だけの印字には号数の印を付ける", () => {
    expect(formatSizeText("10")).toBe("#10");
    expect(formatSizeText("10.5")).toBe("#10.5");
    expect(formatSizeText(" 10 ")).toBe("#10");
  });

  it("⚠⚠ 長さの表記には付けない (号数ではない)", () => {
    expect(formatSizeText("45cm")).toBe("45cm");
    expect(formatSizeText("45 cm")).toBe("45 cm");
    expect(formatSizeText("F")).toBe("F");
  });

  it("⚠ 既に印が付いている印字に二重に付けない", () => {
    expect(formatSizeText("#10")).toBe("#10");
  });

  it("空は null (読めなかった欄は空のまま)", () => {
    expect(formatSizeText(null)).toBeNull();
    expect(formatSizeText("   ")).toBeNull();
  });
});
