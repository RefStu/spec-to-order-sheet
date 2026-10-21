import { describe, expect, it } from "vitest";
import { formatCodeMasterText } from "./code-master";

/**
 * ★ 実物の ORDER SHEET は `YYYY-MM-Sxxx` の形。依頼書の仕様書No は**升目に区切られて
 *   印字**されているので、読み取りが空白を挟んで返すことがある。
 * ⚠⚠ 整えてよいのは**区切りの前後だけ**。桁を足したり年を補ったりしない。
 */
describe("formatCodeMasterText — ORDER SHEET に載せる形にする", () => {
  it("★ 区切りの前後の空白を詰める", () => {
    expect(formatCodeMasterText("2099 - 12 - S002")).toBe("2099-12-S002");
    expect(formatCodeMasterText("2099-12-S002")).toBe("2099-12-S002");
  });

  it("★ 区切りが空白だけのときは区切りに替える", () => {
    expect(formatCodeMasterText("2099 12 S002")).toBe("2099-12-S002");
  });

  it("★ 全角の区切りは半角に寄せる", () => {
    expect(formatCodeMasterText("2099－12－S002")).toBe("2099-12-S002");
    expect(formatCodeMasterText("2099　-　12　-　S002")).toBe("2099-12-S002");
  });

  it("⚠⚠ 2 桁の年はそのまま (世紀を当てずっぽうで決めない)", () => {
    expect(formatCodeMasterText("99-05-S001")).toBe("99-05-S001");
    expect(formatCodeMasterText("99 - 05 - S001")).toBe("99-05-S001");
  });

  it("⚠ 区切りの無い番号は触らない", () => {
    expect(formatCodeMasterText("S002")).toBe("S002");
    expect(formatCodeMasterText("G990321")).toBe("G990321");
  });

  it("⚠ 長音符は区切りにしない (仮名を壊さない)", () => {
    expect(formatCodeMasterText("キーA")).toBe("キーA");
  });

  it("空は null", () => {
    expect(formatCodeMasterText(null)).toBeNull();
    expect(formatCodeMasterText("   ")).toBeNull();
  });
});
