import { describe, expect, it } from "vitest";
import { looksFabricated, toFieldRecord } from "./extraction-fields";

const target = {
  table: "order_sheet_lines",
  rowId: "01900000-0000-7000-8000-000000000001",
  column: "quantity",
};

describe("toFieldRecord", () => {
  it("読めた欄は 欄 1 つ = 1 行 になる", () => {
    expect(toFieldRecord({ value: 12, quote: "12", page: 2, confidence: 98 }, target)).toEqual({
      targetTable: "order_sheet_lines",
      targetRowId: target.rowId,
      targetColumn: "quantity",
      rawValue: "12",
      normalizedValue: "12",
      confidence: 98,
      pageNo: 2,
    });
  });

  it("⚠ 印字が無かった欄は行を作らない (正答率の分母を水増ししない)", () => {
    // 分母は「AI が埋めた欄」。埋めなかった欄を数えると正答率が実態より低く出る。
    expect(
      toFieldRecord({ value: null, quote: null, page: null, confidence: 0 }, target),
    ).toBeNull();
  });

  it("正規化後の値と印字そのままを別々に持つ", () => {
    const record = toFieldRecord(
      { value: "2026-11-20", quote: "2026/11/20", page: 1, confidence: 90 },
      { ...target, column: "ship_date" },
    );
    expect(record?.normalizedValue).toBe("2026-11-20");
    expect(record?.rawValue).toBe("2026/11/20");
  });
});

describe("looksFabricated", () => {
  it("値はあるのに原本の印字が無ければ疑う", () => {
    expect(looksFabricated({ value: "MFG-1", quote: null, page: 1, confidence: 90 }, null)).toBe(
      true,
    );
    expect(looksFabricated({ value: "MFG-1", quote: "  ", page: 1, confidence: 90 }, null)).toBe(
      true,
    );
  });

  it("印字がページの文字に見当たらなければ疑う", () => {
    const page = "発注番号 PO-0001 品番 MFG-000123";
    expect(
      looksFabricated({ value: "MFG-000999", quote: "MFG-000999", page: 1, confidence: 95 }, page),
    ).toBe(true);
    expect(
      looksFabricated({ value: "MFG-000123", quote: "MFG-000123", page: 1, confidence: 95 }, page),
    ).toBe(false);
  });

  it("ページの文字が取れていないときは疑わない (スキャン PDF ではテキスト層が無い)", () => {
    expect(looksFabricated({ value: "MFG-1", quote: "MFG-1", page: 1, confidence: 90 }, null)).toBe(
      false,
    );
  });

  it("読まなかった欄は疑わない", () => {
    expect(looksFabricated({ value: null, quote: null, page: null, confidence: 0 }, "なにか")).toBe(
      false,
    );
  });
});
