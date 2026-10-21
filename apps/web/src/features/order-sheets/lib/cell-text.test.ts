import { describe, expect, it } from "vitest";
import { headerCellText, qtyNumberOf, sheetDateText, todayIsoDate } from "./cell-text";
import { HEADER_CELLS } from "./order-sheet-layout";

/**
 * ★★ セルの文字の規則（「画面に出ている文字が、そのまま xlsx に入る」）。
 *
 * ⚠⚠ **画面側に写しがある**（`cases/lib/order-sheet-form.ts` の `HEADER_PREFIXES` /
 *   `qtyNumberOf()`）。`cases/lib/order-sheet-form.test.ts` が**同じ表**で突き合わせるので、
 *   ここの表を変えたらあちらも変えること（片方だけだと画面の合計と xlsx の `SUM` がずれる）。
 */

/** QTY の判定の表。⚠ `cases/lib/order-sheet-form.test.ts` の `QTY_CASES` と同じ中身にする。 */
const QTY_CASES: [text: string, expected: number | null][] = [
  ["5", 5],
  ["0", 0],
  [" 12 ", 12],
  ["2.5", 2.5],
  ["-1", -1],
  ["12345678901", 12345678901],
  // ⚠ 数値にすると別の文字に見えるものは文字のまま（`SUM` に入らない）。
  ["3.0", null],
  ["03", null],
  ["1e3", null],
  ["0x10", null],
  ["+3", null],
  ["-0", null],
  ["123456789012", null],
  // ⚠ 数として読めない文字も文字のまま（以前は xlsx でだけ消えていた）。
  ["３", null],
  ["3個", null],
  ["約 3", null],
  ["สาม", null],
  ["", null],
];

describe("qtyNumberOf — QTY を数値のセルにしてよいか", () => {
  it.each(QTY_CASES)("%j → %j", (text, expected) => {
    expect(qtyNumberOf(text)).toBe(expected);
  });

  /** ★★ 数を返すのは「数値にしても同じ文字に見える」ときだけ（画面と xlsx の文字が揃う）。 */
  it("★★ 数を返すときは、その数の文字が元の文字と同じ", () => {
    for (const [text] of QTY_CASES) {
      const n = qtyNumberOf(text);
      if (n !== null) expect(String(n)).toBe(text.trim());
    }
  });

  it("null / 数値もそのまま扱える（契約の値は string | number | null）", () => {
    expect(qtyNumberOf(null)).toBeNull();
    expect(qtyNumberOf(undefined)).toBeNull();
    expect(qtyNumberOf(7)).toBe(7);
  });
});

describe("headerCellText — ヘッダの印字の接頭辞と値", () => {
  it("実例の形（`SHIP : 15/3/99` / `Customer PO : …`）", () => {
    expect(headerCellText("SHIP : ", "15/3/99")).toBe("SHIP : 15/3/99");
    expect(headerCellText("Customer PO : ", "F10009999")).toBe("Customer PO : F10009999");
  });

  it("★ 日本語・タイ語の値も変えない", () => {
    expect(headerCellText("SHIP : ", "10月上旬")).toBe("SHIP : 10月上旬");
    expect(headerCellText("SO: ", "ส่งด่วน")).toBe("SO: ส่งด่วน");
  });

  it("⚠ 値が空なら接頭辞ごと空（`SHIP : ` だけを残さない）", () => {
    expect(headerCellText("SHIP : ", null)).toBeNull();
    expect(headerCellText("SHIP : ", "   ")).toBeNull();
    expect(headerCellText("SHIP : ", undefined)).toBeNull();
  });

  /**
   * ⚠⚠ 接頭辞の一覧は画面に写してある（`cases/lib/order-sheet-form.ts` の `HEADER_PREFIXES`）。
   *   **同じリテラル**をここにも書いて、正のほうが動いたら落ちるようにする。
   */
  it("★★ 接頭辞の一覧（画面の写しと同じ）", () => {
    const prefixes = Object.fromEntries(
      HEADER_CELLS.filter((header) => header.prefix.length > 0).map((header) => [
        header.cell,
        header.prefix,
      ]),
    );
    expect(prefixes).toEqual({
      J5: "SHIP : ",
      J7: "Customer PO : ",
      A12: "CUSTOMER: ",
      D12: "PO: ",
      F12: "SO: ",
      J12: "DATE : ",
    });
  });
});

describe("sheetDateText — DATE（J12）を実例の書き方にする", () => {
  it("`d/m/yy`（例: `J12` に `28/4/99`）", () => {
    expect(sheetDateText("2099-04-28")).toBe("28/4/99");
    expect(sheetDateText("2099-02-01")).toBe("1/2/99");
    expect(sheetDateText("2099-12-31")).toBe("31/12/99");
  });

  it("読めなければ null（別の文字を作らない）", () => {
    expect(sheetDateText("2099/02/01")).toBeNull();
    expect(sheetDateText("")).toBeNull();
    expect(sheetDateText(null)).toBeNull();
  });

  it("todayIsoDate は UTC の日付（画面と xlsx が同じ関数を使う）", () => {
    expect(todayIsoDate(new Date("2026-09-26T23:59:59Z"))).toBe("2026-09-26");
  });
});
