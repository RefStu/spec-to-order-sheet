import { describe, expect, it } from "vitest";
import {
  allLineCellRefs,
  BLOCK_COUNT,
  BLOCK_ROWS,
  blockCountOf,
  CELL_COLUMNS,
  CELL_GEOMETRY_VERSION,
  computedCellsOf,
  EDITABLE_HEADER_CELLS,
  FIRST_BLOCK_ROW,
  HEADER_CELLS,
  HEADER_VALUE_CELLS,
  isHeaderCellRef,
  isLineCellRef,
  lastBlockRowOf,
  lineCellRef,
  lineCellRefs,
  lineHeadingOf,
  MAX_CELL_OFFSET,
  MIN_CELL_OFFSET,
  parseLineCellRef,
  PLAN_CELLS,
  PLAN_VALUE_CELLS,
  SHEET_COLUMNS,
  SHEET_HEADINGS,
  SHEET_MERGES,
  sheetHeadingsOf,
  TEMPLATE_TOTAL_ROW,
  totalHeadingsOf,
  totalRowOf,
  VALUE_ROW,
} from "./order-sheet-layout";

/** その番地が、明細 `lines` 件のときに**描き出す枠**のセルか。 */
function isUsedLineCell(ref: string, lines: number): boolean {
  const parsed = parseLineCellRef(ref);
  return parsed !== null && parsed.lineIndex < Math.max(1, lines);
}

/**
 * ★ 明細の枠の形と、セルの鍵。
 *
 * ⚠ 鍵の形が変わると**保存済みの `cells_json` が読めなくなる**ので、ここで固定する。
 */
describe("枠の形", () => {
  /**
   * ⚠⚠ **実物を実測して決めた。** 根拠は 3 つとも紙のほうにある:
   *   ① 元にした実物の xlsx（非公開）の行 15 に `top: thin`、行 20 に `bottom: thin`（枠 = 15..20）
   *   ② 行 15〜26 だけが `ht=45`。行 27 は既定の高さで罫線なし（枠と合計の間の空き行）で、
   *      合計の `I28` は `SUM(I15:I26)`
   *   ③ `drawing1.xml` の写真の錨が行 15 と行 21（= 各枠の先頭行）にある
   * ⚠⚠ **1 行目に値を戻さないこと。** 一度やったが、見たのはコードだけだった。
   */
  it("★ 枠は 15 から 6 行ずつ、値は枠の 2 行目", () => {
    expect(FIRST_BLOCK_ROW).toBe(15);
    expect(BLOCK_ROWS).toBe(6);
    expect(VALUE_ROW).toBe(1);
    expect(BLOCK_COUNT).toBe(12);
  });

  /** ⚠ 枠の直後ではなく、空き行を 1 本はさむ（実物が 26→27→28）。 */
  it("★ 雛形（12 枠）の合計の行は枠の末尾の 2 つ下", () => {
    const lastBlockRow = FIRST_BLOCK_ROW + BLOCK_ROWS * BLOCK_COUNT - 1;
    expect(lastBlockRow).toBe(86);
    expect(TEMPLATE_TOTAL_ROW).toBe(88);
  });
});

/**
 * ★★ 枠は明細の数だけ、合計は最後の枠から 1 行空けた行。
 *
 * ⚠⚠ **実物（明細 2 件）が「枠 15〜26 → 空き行 27 → 合計 28 = `SUM(I15:I26)`」**。
 *   以前は枠はいつも 12 個・合計はいつも `I88` だった。
 */
describe("★★ 明細の数ごとの形", () => {
  it.each([
    // [明細の数, 枠の数, 最後の枠の末尾, 合計の行]
    [0, 1, 20, 22],
    [1, 1, 20, 22],
    [2, 2, 26, 28],
    [5, 5, 44, 46],
    [12, 12, 86, 88],
  ])("明細 %i 件 → 枠 %i 個・末尾 %i・合計 %i", (lines, blocks, last, total) => {
    expect(blockCountOf(lines)).toBe(blocks);
    expect(lastBlockRowOf(lines)).toBe(last);
    expect(totalRowOf(lines)).toBe(total);
    // ⚠ 空き行は 1 本だけ。
    expect(totalRowOf(lines) - lastBlockRowOf(lines)).toBe(2);
  });

  it("★ 実物（明細 2 件）と同じ番地になる", () => {
    expect(totalRowOf(2)).toBe(28);
    expect(computedCellsOf(2)).toEqual(["G7", "I28"]);
    expect(totalHeadingsOf(2)).toEqual([{ cell: "J28", text: "PCS" }]);
  });

  it("⚠ 12 件で雛形と同じ（合計 88）", () => {
    expect(totalRowOf(BLOCK_COUNT)).toBe(TEMPLATE_TOTAL_ROW);
  });

  /** ⚠ 上限を超えた数は黙って丸めない（呼び手は先に 422 で断っている）。 */
  it("⚠ 枠に収まらない数は例外", () => {
    expect(() => totalRowOf(BLOCK_COUNT + 1)).toThrow();
    expect(() => totalRowOf(-1)).toThrow();
    expect(() => totalRowOf(1.5)).toThrow();
  });

  /**
   * ⚠ 合計の行の見出しが、**描き出す枠**にも固定の見出しにも重ならないこと。
   *
   * ⚠⚠ 番地だけを見れば `J28` は「3 件目の枠の Unit」と同じ文字列になる（幾何は 12 枠ぶんの
   *   番地を持っているため）。**3 件目が無いときにだけ**合計の行がそこへ上がるので衝突しない。
   *   `isLineCellRef()` で判定すると落ちるのはそのため — 見るのは「その件数で使う枠か」。
   */
  it("★ 合計の行の見出しは使う枠の外で、固定の見出しと重ならない", () => {
    for (let lines = 0; lines <= BLOCK_COUNT; lines++) {
      const [unit] = totalHeadingsOf(lines);
      expect(isUsedLineCell(unit!.cell, lines)).toBe(false);
      expect(SHEET_HEADINGS.some((heading) => heading.cell === unit!.cell)).toBe(false);
      expect(sheetHeadingsOf(lines)).toHaveLength(SHEET_HEADINGS.length + 1);
    }
  });
});

describe("セルの番地", () => {
  /** ⚠ A は連番、E は写真なので入力欄にしない。 */
  it("⚠ 列は A と E を除いた 10 列", () => {
    expect([...CELL_COLUMNS]).toEqual(["B", "C", "D", "F", "G", "H", "I", "J", "K", "L"]);
  });

  it("差は枠の中だけ（-1..4）", () => {
    expect(MIN_CELL_OFFSET).toBe(-1);
    expect(MAX_CELL_OFFSET).toBe(4);
    expect(lineCellRefs(0)).toHaveLength(CELL_COLUMNS.length * BLOCK_ROWS);
  });

  /**
   * ⚠⚠ **幾何を動かしたら `CELL_GEOMETRY_VERSION` を上げること。**
   *   鍵が絶対番地になったので、`FIRST_BLOCK_ROW` / `BLOCK_ROWS` / `VALUE_ROW` /
   *   `BLOCK_COUNT` のどれかを動かすと **`order_sheet_lines.cells_json` /
   *   `ai_extraction_fields.target_column` / `ai_field_corrections.target_column` の
   *   3 表が同時に腐る**。ここが落ちたら、**データ migration を書いたか**を確かめること。
   */
  it("★★ 幾何の版と、番地の総数を固定する", () => {
    expect(CELL_GEOMETRY_VERSION).toBe(1);
    expect(allLineCellRefs()).toHaveLength(CELL_COLUMNS.length * BLOCK_ROWS * BLOCK_COUNT);
    // 端だけ固定する（720 件を書き写さない）。
    const refs = allLineCellRefs();
    expect(refs).toContain("B15");
    expect(refs).toContain("L86");
    expect(refs).not.toContain("A16");
    expect(refs).not.toContain("E16");
  });

  it("作って読み直すと元に戻る", () => {
    for (const ref of allLineCellRefs()) {
      const parsed = parseLineCellRef(ref);
      expect(parsed).not.toBeNull();
      expect(lineCellRef(parsed!.column, parsed!.lineIndex, parsed!.rowOffset)).toBe(ref);
    }
  });

  /** ⚠ 形が違うものを黙って通さない（`cells_json` に変な番地を入れない）。 */
  it("⚠ 使えない番地は弾く", () => {
    for (const bad of [
      // ⚠ 昔の相対の鍵。**もう通さない**（通すと世代が混ざる）。
      "F:0",
      "D:1",
      // 列が違う / 枠の外 / 形が違う。
      "A16",
      "E16",
      "M16",
      "F14",
      "F87",
      "F88",
      "F",
      "16",
      "f16",
      "F16.5",
    ]) {
      expect(isLineCellRef(bad)).toBe(false);
    }
    expect(() => lineCellRef("A", 0, 0)).toThrow();
    expect(() => lineCellRef("F", 0, 5)).toThrow();
    expect(() => lineCellRef("F", BLOCK_COUNT, 0)).toThrow();
  });

  /**
   * ⚠⚠ **番地は実物と一致すること。** 実物では `D17` に原型No、`F17` に POLISH、
   *   `F20` にロゴが入っている。
   */
  it("★ 番地が実物と合う", () => {
    expect(lineCellRef("G", 0, 0)).toBe("G16");
    expect(lineCellRef("I", 1, 0)).toBe("I22");
    expect(lineCellRef("D", 0, 1)).toBe("D17");
    expect(lineCellRef("F", 0, 1)).toBe("F17");
    expect(lineCellRef("F", 0, 4)).toBe("F20");
    // 枠の 1 行目（実物は空）。
    expect(lineCellRef("B", 0, -1)).toBe("B15");
    // 12 件目の枠は 81..86。
    expect(lineCellRef("I", BLOCK_COUNT - 1, 0)).toBe("I82");
    expect(lineCellRef("F", BLOCK_COUNT - 1, 4)).toBe("F86");
  });
});

describe("見出しとヘッダ", () => {
  /**
   * ⚠⚠ **見出しの番地と明細の番地は重ならない。** これが「見出しは欄ではない」の
   *   技術的な担保で、人が打った値が見出しを上書きすることが**構造的に起きない**。
   */
  it("★★ 見出し・ヘッダの番地は明細の番地と重ならない", () => {
    for (const heading of SHEET_HEADINGS) {
      expect(isLineCellRef(heading.cell)).toBe(false);
    }
    for (const header of HEADER_CELLS) {
      expect(isLineCellRef(header.cell)).toBe(false);
    }
  });

  /**
   * ⚠⚠ **末尾の空白を整えないこと。** 実物がこう印字されている。
   *   整えると xlsx が実物と 1 文字ずれる（狙いは「完全に再現する」こと）。
   */
  it("⚠ 末尾の空白まで実物どおり", () => {
    expect(SHEET_HEADINGS.find((h) => h.cell === "F2")?.text).toBe("ORDER SHEET  ");
    expect(SHEET_HEADINGS.find((h) => h.cell === "K14")?.text).toBe("SHIP DATE ");
  });

  /** ⚠ 明細の見出しは A14:L14 の 12 列ぶん（画面の列見出しはこれを写す）。 */
  it("★ 明細の見出しは実物の並びそのまま", () => {
    expect(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"].map(lineHeadingOf)).toEqual(
      [
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
        "SHIP DATE ",
        "REMARK",
      ],
    );
  });

  /**
   * ⚠ 人が打てるのは 4 つ ＋ 工程表の 21 個。派生（`A12` / `J12` / `F5`）は打たせない。
   * ⚠⚠ **工程表（`C4:E10`）が加わって 4 → 25 になった。**
   */
  it("★ 人が打てるヘッダは J5 / J7 / D12 / F12 ＋ 工程表の 21 個", () => {
    expect([...EDITABLE_HEADER_CELLS]).toEqual(["J5", "J7", "D12", "F12", ...PLAN_CELLS]);
    for (const derived of ["A12", "J12", "F5"]) {
      expect(isHeaderCellRef(derived)).toBe(false);
    }
  });

  /**
   * ⚠⚠ **同じ一覧を 2 つ持っている理由**は型だけ（`z.enum()` がリテラルのタプルを要求する）。
   *   中身が食い違ったら、契約と writer の門番がずれて
   *   **「打てるのに保存されない欄」か「保存されるのに契約が弾く欄」**ができる。
   */
  it("★★ HEADER_VALUE_CELLS と EDITABLE_HEADER_CELLS は同じ", () => {
    expect([...HEADER_VALUE_CELLS]).toEqual([...EDITABLE_HEADER_CELLS]);
  });
});

/**
 * ★ 紙の形のうち、コードへ移したもの（結合・数式・工程表・列）。
 *
 * ⚠ 雛形の XML との突き合わせは `order-sheet-template.test.ts` の担当。
 *   ここは**定数どうしの辻褄**だけを見る。
 */
describe("紙の形", () => {
  it("★ 列は A..L の 12 列（⚠ CELL_COLUMNS とは別物）", () => {
    expect([...SHEET_COLUMNS]).toEqual(
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"],
    );
    // ⚠ A（連番）と E（写真）は明細のセルにならない。ここが読み書きの分かれ目。
    expect([...CELL_COLUMNS]).not.toContain("A");
    expect([...CELL_COLUMNS]).not.toContain("E");
  });

  /**
   * ⚠⚠ **リテラルのタプルで持っている**（`z.enum()` のため）ので、
   *   `PLAN_VALUE_CELLS` の範囲とずれていないことを機械で確かめる。
   */
  it("★★ PLAN_CELLS は PLAN_VALUE_CELLS の範囲そのもの", () => {
    const expected: string[] = [];
    for (let row = PLAN_VALUE_CELLS.firstRow; row <= PLAN_VALUE_CELLS.lastRow; row++) {
      for (const column of PLAN_VALUE_CELLS.columns) expected.push(`${column}${row}`);
    }
    expect([...PLAN_CELLS]).toEqual(expected);
    expect(PLAN_CELLS).toHaveLength(21);
  });

  /** ⚠ 工程表のセルが見出しや明細と重ならないこと（重なると値が印字を上書きする）。 */
  it("★★ 工程表のセルは見出しとも明細とも重ならない", () => {
    const headings = new Set(SHEET_HEADINGS.map((heading) => heading.cell));
    for (const ref of PLAN_CELLS) {
      expect(headings.has(ref)).toBe(false);
      expect(isLineCellRef(ref)).toBe(false);
    }
  });

  it("★ 結合セルは実物の 7 つ", () => {
    expect([...SHEET_MERGES]).toEqual([
      "B2:E2",
      "F2:G4",
      "F5:G6",
      "G7:G8",
      "H7:H8",
      "J5:L6",
      "J7:L8",
    ]);
  });

  /**
   * ⚠⚠ **結合は行 2〜8 にしかない。** 明細（15〜86）と合計（88）に結合があると、
   *   画面の格子も xlsx の行の複製も破綻する。
   */
  it("★★ 結合は明細にも合計にも掛からない", () => {
    for (const merge of SHEET_MERGES) {
      for (const ref of merge.split(":")) {
        const row = Number(/\d+/.exec(ref)?.[0]);
        expect(row).toBeLessThan(12);
        expect(isLineCellRef(ref)).toBe(false);
      }
    }
  });

  /** ⚠ 数式のセル。**数式を値で置き換えない**（上書きすると合計が追従しなくなる）。 */
  it("★ 数式のセルは G7 と I<合計>（12 件なら I88）", () => {
    expect(computedCellsOf(BLOCK_COUNT)).toEqual(["G7", "I88"]);
    for (let lines = 0; lines <= BLOCK_COUNT; lines++) {
      // ⚠ 見出しでも明細でもない（どちらかに入っていたら二重管理になっている）。
      for (const ref of computedCellsOf(lines)) {
        expect(sheetHeadingsOf(lines).some((heading) => heading.cell === ref)).toBe(false);
        expect(isUsedLineCell(ref, lines)).toBe(false);
      }
    }
  });
});
