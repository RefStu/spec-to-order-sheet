import { describe, expect, it } from "vitest";
import {
  BLOCK_COUNT,
  BLOCK_ROWS,
  blockRowOf,
  CELL_COLUMNS,
  blockCountOf,
  cellRefOf,
  computedCellsOf,
  DERIVED_HEADER_CELLS,
  FIRST_BLOCK_ROW,
  HEADER_PREFIXES,
  HEADER_VALUE_CELLS,
  isLineCellRef,
  PLAN_CELLS,
  qtyNumberOf,
  qtyRefOf,
  SHEET_COLUMNS,
  SHEET_HEADINGS,
  TOTAL_UNIT_TEXT,
  totalRowOf,
  VALUE_ROW,
} from "./order-sheet-form";
import { HEADER_FIELD_LABELS, READ_ONLY_HEADER_KEYS } from "./order-sheet-contract";

/**
 * ★★ **正は `features/order-sheets/lib/order-sheet-layout.ts`。**
 *   feature をまたいで import できない（ESLint の boundaries は `import type` も禁止）ので、
 *   **リテラルで突き合わせる**。ずれたらここが落ちる。
 */

describe("明細の形", () => {
  it("★ 明細の見出しは実物の並びそのまま", () => {
    expect(SHEET_COLUMNS.map((column) => SHEET_HEADINGS[`${column}14`])).toEqual([
      "No.",
      "Code",
      "ID",
      "Code Master",
      "Picture",
      "Description",
      "STONE",
      "Size",
      "QTY",
      "Unit",
      "SHIP DATE",
      "REMARK",
    ]);
  });

  /**
   * ⚠⚠ **正のほうは末尾の空白まで持っている**（`"ORDER SHEET  "` / `"SHIP DATE "`）。
   *   画面は `.trim()` した形で持つ。**正のほうを整えないこと** — xlsx を実物と
   *   1 文字も違わず再現するのが狙い。
   */
  it("★★ 画面の見出しは trim 済み（正は空白を持ったまま）", () => {
    expect(SHEET_HEADINGS.F2).toBe("ORDER SHEET");
    expect(SHEET_HEADINGS.K14).toBe("SHIP DATE");
  });

  /**
   * ⚠⚠ ずれると「画面が打った値は**保存はされる**が xlsx の**違う番地**に出る」という
   *   気づきにくい壊れ方をする。
   */
  it("★ セルの番地が API の契約と一致する", () => {
    expect(cellRefOf("F", 1, 0)).toBe("F16");
    expect(cellRefOf("F", 1, 1)).toBe("F17");
    expect(cellRefOf("F", 1, -1)).toBe("F15");
    expect(cellRefOf("F", 2, 0)).toBe("F22");
    expect(qtyRefOf(1)).toBe(cellRefOf("I", 1, 0));
    expect(qtyRefOf(2)).toBe("I22");
  });

  /**
   * ★ 明細 1 件 = 6 行で、枠の 1 行目は空・値は 2 行目 (実物と同じ)。
   *
   * ⚠⚠ **実物を実測して**決めた。根拠は 3 つとも紙のほうにある
   *   (罫線・行の高さ・drawing の錨。`order-sheet-layout.ts` に書いてある)。
   *   ⚠ **`VALUE_ROW` を `0` に戻さないこと。**
   */
  it("★ 明細 1 件 = 6 行で、値は枠の 2 行目", () => {
    expect(BLOCK_ROWS).toBe(6);
    expect(VALUE_ROW).toBe(1);
  });

  it("★ 明細の番地が xlsx と一致する", () => {
    expect(FIRST_BLOCK_ROW).toBe(15);
    expect(BLOCK_COUNT).toBe(12);
    expect(totalRowOf(BLOCK_COUNT)).toBe(88);
    expect(blockRowOf(1)).toBe(15);
    expect(blockRowOf(2)).toBe(21);
    expect(blockRowOf(BLOCK_COUNT)).toBe(81);
    expect(cellRefOf("G", 1, 0)).toBe("G16");
    expect(cellRefOf("I", 2, 0)).toBe("I22");
  });

  /**
   * ★★ **A 列 (連番) と E 列 (写真) は明細のセルにならない。**
   *   ここが「どのセルが打てるか」の分かれ目。`"A16"` / `"E16"` を作って PATCH に
   *   混ぜると、API の `cellKeySchema` が弾いて**保存ごと落ちる**。
   */
  it("★★ isLineCellRef は A 列と E 列を弾く", () => {
    expect([...CELL_COLUMNS]).toEqual(["B", "C", "D", "F", "G", "H", "I", "J", "K", "L"]);
    for (const ref of ["B15", "F16", "D17", "F20", "I82", "F86", "L86"]) {
      expect(isLineCellRef(ref), ref).toBe(true);
    }
    // ⚠ A / E は列ごと偽。枠の外 (見出し・ヘッダ・空き行・合計) も偽。
    for (const ref of ["A16", "E16", "A15", "E20", "M16", "F14", "F2", "F87", "F88", "f16"]) {
      expect(isLineCellRef(ref), ref).toBe(false);
    }
  });

  it("★ 枠のどのセルにも番地がある (A 列と E 列を除く)", () => {
    for (let lineNo = 1; lineNo <= BLOCK_COUNT; lineNo++) {
      for (let offset = -VALUE_ROW; offset <= BLOCK_ROWS - 1 - VALUE_ROW; offset++) {
        for (const column of CELL_COLUMNS) {
          const ref = cellRefOf(column, lineNo, offset);
          expect(ref).toMatch(/^[A-L]\d+$/u);
          expect(isLineCellRef(ref), ref).toBe(true);
        }
      }
    }
  });
});

/**
 * ★ 紙の全体。
 */
describe("紙の全体", () => {
  it("★ 列は A..L の 12 列", () => {
    expect([...SHEET_COLUMNS]).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
    ]);
  });

  it("★ 工程表は C4:E10 の 21 個", () => {
    expect(PLAN_CELLS).toHaveLength(21);
    expect(PLAN_CELLS[0]).toBe("C4");
    expect(PLAN_CELLS[PLAN_CELLS.length - 1]).toBe("E10");
    for (const ref of PLAN_CELLS) expect(isLineCellRef(ref), ref).toBe(false);
  });

  it("★ 人が打てるヘッダは 4 つ ＋ 工程表の 21 個", () => {
    expect([...HEADER_VALUE_CELLS]).toEqual(["J5", "J7", "D12", "F12", ...PLAN_CELLS]);
    // ⚠ 派生は打たせない（order-sheets 側の writer も同じ 2 つを捨てる）。
    expect([...READ_ONLY_HEADER_KEYS]).toEqual(["A12", "J12"]);
    // ⚠ `F5`（取引先名）は契約に無い。`A12` と同じ `partners.name` から出す。
    expect([...DERIVED_HEADER_CELLS]).toEqual(["A12", "J12", "F5"]);
    expect(HEADER_FIELD_LABELS).toEqual({
      J5: "SHIP",
      J7: "Customer PO",
      A12: "CUSTOMER",
      D12: "PO",
      F12: "SO",
      J12: "DATE",
    });
  });

  /**
   * ★★ 枠は明細の数だけ、合計は最後の枠から 1 行空けた行。正は `order-sheet-layout.ts` の
   *   `totalRowOf()`（`order-sheet-layout.test.ts` が同じ表で固定する）。
   * ⚠ 実物（明細 2 件）は合計 `I28` / `J28`。
   */
  it.each([
    [0, 1, 22],
    [1, 1, 22],
    [2, 2, 28],
    [5, 5, 46],
    [12, 12, 88],
  ])("★★ 明細 %i 件 → 枠 %i 個・合計の行 %i", (lines, blocks, total) => {
    expect(blockCountOf(lines)).toBe(blocks);
    expect(totalRowOf(lines)).toBe(total);
    expect(computedCellsOf(lines)).toEqual(["G7", `I${total}`]);
  });

  it("⚠ 画面は上限を超えても落とさず 12 枠で止める（xlsx の出口が 422 で断る）", () => {
    expect(blockCountOf(BLOCK_COUNT + 3)).toBe(BLOCK_COUNT);
  });

  it("★ 合計の行の単位は PCS（実物の J28）", () => {
    expect(TOTAL_UNIT_TEXT).toBe("PCS");
  });
});

/*
 * ⚠⚠ **「画面の列幅と行の高さ」と「結合セル」はここで検査しない。**
 *   画面は紙の格子ではなく区画と入力欄の GUI なので (`order-sheet-sections.ts`)、
 *   列幅・行の高さ・結合は写していない。
 *   ⚠⚠ **正の `order-sheets/lib/order-sheet-layout.ts` 側の `SHEET_MERGES` は生きている**
 *   (xlsx が実物どおりに出ることは `order-sheet-template.test.ts` が見ている)。
 *   ⚠ 写し (`SHEET_COLUMNS` / `SHEET_HEADINGS` / `PLAN_CELLS` / 幾何) の検査は
 *   そのまま残してある。ここが正との唯一の突き合わせなので、減らさないこと。
 */

/**
 * ★★ 画面の文字と xlsx の文字を揃えるための写し。
 *   正は `order-sheets/lib/cell-text.ts`（`cell-text.test.ts` が**同じ表**で固定する）。
 * ⚠⚠ 片方だけ直すと、画面の接頭辞と xlsx の接頭辞、画面の合計と xlsx の `SUM` がずれる。
 */
describe("★★ セルの文字の規則の写し", () => {
  it("ヘッダの印字の接頭辞（空白の数まで実物どおり）", () => {
    expect(HEADER_PREFIXES).toEqual({
      J5: "SHIP : ",
      J7: "Customer PO : ",
      A12: "CUSTOMER: ",
      D12: "PO: ",
      F12: "SO: ",
      J12: "DATE : ",
    });
  });

  /** ⚠ `order-sheets/lib/cell-text.test.ts` の `QTY_CASES` と同じ中身にする。 */
  const QTY_CASES: [text: string, expected: number | null][] = [
    ["5", 5],
    ["0", 0],
    [" 12 ", 12],
    ["2.5", 2.5],
    ["-1", -1],
    ["12345678901", 12345678901],
    ["3.0", null],
    ["03", null],
    ["1e3", null],
    ["0x10", null],
    ["+3", null],
    ["-0", null],
    ["123456789012", null],
    ["３", null],
    ["3個", null],
    ["約 3", null],
    ["สาม", null],
    ["", null],
  ];

  it.each(QTY_CASES)("QTY %j → %j", (text, expected) => {
    expect(qtyNumberOf(text)).toBe(expected);
  });
});
