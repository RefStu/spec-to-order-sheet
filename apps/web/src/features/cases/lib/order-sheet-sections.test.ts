import { describe, expect, it } from "vitest";
import type { Field, OrderSheet } from "./order-sheet-contract";
import {
  BLANK_CELL,
  BLOCK_COUNT,
  cellRefOf,
  computedCellsOf,
  DERIVED_HEADER_CELLS,
  HEADER_VALUE_CELLS,
  isLineCellRef,
  PLAN_CELLS,
  qtyRefOf,
} from "./order-sheet-form";
import {
  buildOrderSheetForm,
  cardFields,
  type FieldSpec,
  type SectionSpec,
} from "./order-sheet-sections";

/**
 * ★ 禁止語（取引先の名前・略号・実在の番号）。`assets/banned-terms.txt` から読む
 *   （手元に置いたときだけ使う。リポジトリには含まない）。
 * ⚠ `node:fs` は apps/web/src では使えないので、vite の `import.meta.glob` で読む
 *   （ファイルが無ければ空のオブジェクトが返る = 落ちずに飛ばせる）。
 */
const BANNED_TERMS = Object.values(
  import.meta.glob<string>("../../../../../../assets/banned-terms.txt", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)
  .flatMap((text) => text.split(/\r?\n/))
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

/**
 * ★★ 画面の区画と欄。**ここが「どの番地に打てるか」の正。**
 *
 * ⚠⚠ このリポジトリに DOM のテストは無い（`vitest.config.ts` は `environment: "node"`）。
 *   だから**形はすべてここで固定する**。部品は返ってきたものを描くだけ。
 */

function field(value: string | number | null, over: Partial<Field> = {}): Field {
  return { ...BLANK_CELL, value, ...over };
}

function sheetWith(
  lines: { lineId: string; lineNo: number; cells?: Record<string, Field> }[] = [
    { lineId: "line-1", lineNo: 1 },
  ],
  header: Record<string, Field> = {},
): OrderSheet {
  return {
    caseId: "case-1",
    orderSheetId: "os-1",
    status: "draft",
    confidenceThreshold: 0.8,
    header,
    lines: lines.map((line) => ({
      lineId: line.lineId,
      lineNo: line.lineNo,
      photos: [],
      picture: BLANK_CELL,
      cells: line.cells ?? {},
    })),
  };
}

function allFields(form: { sections: SectionSpec[] }): FieldSpec[] {
  return form.sections.flatMap((section) => [
    ...section.fields,
    ...section.lines.flatMap((card) => cardFields(card)),
  ]);
}

function cardOf(form: { sections: SectionSpec[] }, lineNo: number) {
  const card = form.sections
    .flatMap((section) => section.lines)
    .find((candidate) => candidate.lineNo === lineNo);
  if (card === undefined) throw new Error(`明細 ${lineNo} のカードが無い`);
  return card;
}

function refOf(form: { sections: SectionSpec[] }, lineNo: number, label: string): string {
  const spec = cardFields(cardOf(form, lineNo)).find((candidate) => candidate.label === label);
  if (spec === undefined) throw new Error(`欄が無い: ${label}`);
  return spec.ref;
}

describe("明細の欄", () => {
  /**
   * ⚠⚠ ずれると「画面が打った値は**保存はされる**が xlsx の**違う番地**に出る」という
   *   気づきにくい壊れ方をする。**番地は導出**で、どこにも書いていないことを固定する。
   */
  it("★★ 番地は cellRefOf() からの導出そのもの", () => {
    const lines = Array.from({ length: BLOCK_COUNT }, (_, i) => ({
      lineId: `line-${i + 1}`,
      lineNo: i + 1,
    }));
    const form = buildOrderSheetForm(sheetWith(lines));

    // 明細 1（実物の block 1 = 行 15..20、値は行 16）
    expect(cardFields(cardOf(form, 1)).map((spec) => spec.ref)).toEqual([
      "B16",
      "C16",
      "D16",
      "D17",
      "F16",
      "F17",
      "F18",
      "F20",
      "G16",
      "H16",
      "I16",
      "J16",
      "K16",
      "L16",
    ]);
    // 明細 12（block 12 = 行 81..86、値は行 82）
    expect(refOf(form, 12, "Description #4")).toBe("F86");
    expect(refOf(form, 12, "Code Master #2")).toBe("D83");
    expect(refOf(form, 12, "QTY")).toBe("I82");
    // ⚠ 合計の出どころと QTY の欄は同じ番地でなければならない。
    for (let lineNo = 1; lineNo <= BLOCK_COUNT; lineNo++) {
      expect(cardOf(form, lineNo).qtyRef).toBe(qtyRefOf(lineNo));
      expect(refOf(form, lineNo, "QTY")).toBe(qtyRefOf(lineNo));
    }
    // ⚠ 直書きしていないこと（`cellRefOf` と一致する）。
    expect(refOf(form, 3, "Description #1")).toBe(cellRefOf("F", 3, 0));
    expect(refOf(form, 3, "Description #2")).toBe(cellRefOf("F", 3, 1));
    expect(refOf(form, 3, "Description #3")).toBe(cellRefOf("F", 3, 2));
    expect(refOf(form, 3, "Description #4")).toBe(cellRefOf("F", 3, 4));
  });

  /**
   * ⚠⚠ **`#n` は並び順であって `rowOffset + 1` ではない。**
   *   実物では Description の 4 行目（`F19`）が空なので欄にせず、`#4` は `rowOffset: 4`。
   *   ⚠ ここを「offset + 1」に直すと `#4` が `F19` になり、**1 行ずれたまま保存される**。
   */
  it("★★ Description は 4 つで、F19 は欄にならない", () => {
    const form = buildOrderSheetForm(sheetWith());
    const refs = cardFields(cardOf(form, 1)).map((spec) => spec.ref);
    expect(refs.filter((ref) => ref.startsWith("F"))).toEqual(["F16", "F17", "F18", "F20"]);
    expect(refs).not.toContain("F19");
    // ⚠ Code Master は 2 つ（実物で使われているのは `D16` と `D17` だけ）。
    expect(refs.filter((ref) => ref.startsWith("D"))).toEqual(["D16", "D17"]);
    expect(refs).not.toContain("D18");
  });

  /**
   * ⚠⚠ **行の切り方は転記の読み順。**
   *   **勝手に詰めたり流したりしないこと**。ここが崩れると打つ順番が変わる。
   */
  it("★★ 欄の並びは転記の読み順の 6 行", () => {
    const form = buildOrderSheetForm(sheetWith());
    expect(cardOf(form, 1).rows.map((row) => row.map((spec) => spec.label))).toEqual([
      ["Code", "ID"],
      ["Code Master #1", "Code Master #2"],
      ["Description #1", "Description #2", "Description #3", "Description #4"],
      ["STONE"],
      ["Size", "QTY", "Unit"],
      ["SHIP DATE", "REMARK"],
    ]);
  });

  it("★ 番号が付くのは Code Master と Description だけ", () => {
    const form = buildOrderSheetForm(sheetWith());
    expect(cardFields(cardOf(form, 1)).map((spec) => spec.label)).toEqual([
      "Code",
      "ID",
      "Code Master #1",
      "Code Master #2",
      "Description #1",
      "Description #2",
      "Description #3",
      "Description #4",
      "STONE",
      "Size",
      "QTY",
      "Unit",
      "SHIP DATE",
      "REMARK",
    ]);
  });

  /**
   * ⚠⚠ **A 列（連番）と E 列（写真）は明細のセルにならない。**
   *   混ぜると API の `cellKeySchema` が弾いて**保存ごと 400 で落ちる**。
   * ⚠⚠ `G7` / `I<合計>` は雛形の**数式**。欄にすると値で上書きしてしまう。
   */
  it("★★ 打てる番地に A 列 / E 列 / 数式のセルが混ざらない", () => {
    const lines = Array.from({ length: BLOCK_COUNT }, (_, i) => ({
      lineId: `line-${i + 1}`,
      lineNo: i + 1,
    }));
    const form = buildOrderSheetForm(sheetWith(lines));
    for (const section of form.sections) {
      for (const card of section.lines) {
        for (const spec of cardFields(card)) {
          expect(isLineCellRef(spec.ref), spec.ref).toBe(true);
          expect(spec.ref.startsWith("A"), spec.ref).toBe(false);
          expect(spec.ref.startsWith("E"), spec.ref).toBe(false);
        }
      }
    }
    for (const spec of allFields(form)) {
      expect(computedCellsOf(BLOCK_COUNT).includes(spec.ref), spec.ref).toBe(false);
    }
  });

  /**
   * ★★ 合計の行は**明細の数で動く**。画面も xlsx も同じ番地を指す。
   *
   * ⚠⚠ 実物（明細 2 件）は 枠 15〜26 → 空き行 27 → 合計 28（`I28` / `J28`）。
   * ⚠ 合計のセルが、その件数で**出ている欄**と重ならないこと（重なると値で数式を潰す）。
   */
  it.each([
    [1, "I22", "J22"],
    [2, "I28", "J28"],
    [5, "I46", "J46"],
    [12, "I88", "J88"],
  ])("★★ 明細 %i 件の合計は %s（単位は %s）", (count, cell, unitCell) => {
    const lines = Array.from({ length: count }, (_, i) => ({
      lineId: `line-${i + 1}`,
      lineNo: i + 1,
    }));
    const form = buildOrderSheetForm(sheetWith(lines));
    expect(form.total).toEqual({ label: "合計", unit: "PCS", cell, unitCell });
    expect(computedCellsOf(count)).toEqual(["G7", cell]);
    for (const spec of allFields(form)) {
      expect([cell, unitCell, "G7"].includes(spec.ref), spec.ref).toBe(false);
    }
  });

  it("⚠ 明細 0 件でも合計の行は枠 1 個ぶん（I22）", () => {
    expect(buildOrderSheetForm(sheetWith([])).total.cell).toBe("I22");
  });

  /**
   * ⚠⚠ **`memo` の約束。** `field` は API が返した参照そのままでなければ、
   *   打鍵のたびに全欄が描き直される。
   */
  it("★★ field は API が返した参照そのまま（無い鍵は BLANK_CELL）", () => {
    const f16 = field("CASTING SV950", { filledBy: "ai", confidence: 0.9 });
    const sheet = sheetWith([{ lineId: "line-1", lineNo: 1, cells: { F16: f16 } }]);
    const form = buildOrderSheetForm(sheet);
    const specs = cardFields(cardOf(form, 1));
    expect(specs.find((spec) => spec.ref === "F16")!.field).toBe(f16);
    expect(specs.find((spec) => spec.ref === "L16")!.field).toBe(BLANK_CELL);
  });

  /**
   * ★★ 余りの欄。実物が使っていないセルにも値が残っていることがある
   *   （API は枠の 60 セルどれにも書ける）。**値が残っていたら出す。**
   *   ⚠ 出さないと「保存され、xlsx にも出るのに画面に無い」という壊れ方になる。
   */
  it("★★ 一覧に無い番地に値があれば、その欄も出す", () => {
    const plain = buildOrderSheetForm(sheetWith());
    expect(cardFields(cardOf(plain, 1))).toHaveLength(14);

    const sheet = sheetWith([
      { lineId: "line-1", lineNo: 1, cells: { F19: field("あとから打った"), B15: field(null) } },
    ]);
    const form = buildOrderSheetForm(sheet);
    const refs = cardFields(cardOf(form, 1)).map((spec) => spec.ref);
    expect(refs).toContain("F19");
    // ⚠ 空のセルまで出すと 60 欄に逆戻りする。値のあるものだけ。
    expect(refs).not.toContain("B15");
    expect(cardFields(cardOf(form, 1))).toHaveLength(15);
    // ⚠ 決めてある 6 行の並びを崩さず、**最後の行**に足す。
    expect(cardOf(form, 1).rows).toHaveLength(7);
    expect(cardOf(form, 1).rows[6]!.map((spec) => spec.ref)).toEqual(["F19"]);
  });

  it("★ 明細のカードは lineNo の順で、12 枠を超えるものは出さない", () => {
    const form = buildOrderSheetForm(
      sheetWith([
        { lineId: "line-2", lineNo: 2 },
        { lineId: "line-1", lineNo: 1 },
        // ⚠ 13 件目は枠の外。番地を作ると `isLineCellRef()` が偽になり API が弾く。
        { lineId: "line-13", lineNo: 13 },
      ]),
    );
    const cards = form.sections.flatMap((section) => section.lines);
    expect(cards.map((card) => card.lineNo)).toEqual([1, 2]);
    expect(cards.map((card) => card.title)).toEqual(["明細 #1", "明細 #2"]);
  });
});

describe("記入例", () => {
  /** ⚠ 空の欄に何を書けばよいか分からないと転記できない。**全欄に要る。** */
  it("★ すべての欄に記入例がある（非表示の区画も含む）", () => {
    const form = buildOrderSheetForm(sheetWith());
    for (const spec of allFields(form)) {
      expect(spec.placeholder.length, spec.label).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠⚠ **実データを置かない。** 実物の xlsx はリポジトリに含めないが、
   *   記入例はソースに書くので git に入る。実物に印字されている取引先の略号・
   *   ロゴ・品番が混ざっていないことを固定する。
   * ⚠⚠ **禁止語の一覧はソースに書かない。**一覧そのものが取引先を名指しするので、
   *   `assets/banned-terms.txt`（1 行 1 語。手元に置いたときだけ使う。リポジトリには
   *   含まない）から読む。無ければ飛ばす。
   */
  it.skipIf(BANNED_TERMS.length === 0)(
    `★★ 記入例に実物の取引先が分かる値を書かない${BANNED_TERMS.length === 0 ? "（assets/banned-terms.txt が無いので飛ばす）" : ""}`,
    () => {
      const form = buildOrderSheetForm(sheetWith());
      for (const spec of allFields(form)) {
        for (const banned of BANNED_TERMS) {
          expect(spec.placeholder.includes(banned), `${spec.label}: ${spec.placeholder}`).toBe(
            false,
          );
        }
      }
    },
  );
});

describe("区画", () => {
  it("★ 区画は紙の順で 4 つ、出すのは 2 つだけ", () => {
    const form = buildOrderSheetForm(sheetWith());
    expect(form.sections.map((section) => section.id)).toEqual([
      "productionPlan",
      "customer",
      "shipCustomerPo",
      "orderSheet",
    ]);
    expect(form.sections.map((section) => section.visible)).toEqual([false, false, true, true]);
    expect(form.sections.map((section) => section.title)).toEqual([
      "PRODUCTION PLAN",
      "Customer",
      "SHIP & Customer PO",
      "ORDER SHEET",
    ]);
  });

  /**
   * ⚠⚠ **非表示にしただけで、データは 1 つも外していない。**
   *   工程表（`C4:E10`）は `HEADER_VALUE_CELLS` 経由で xlsx に出続ける。
   *   ここが空になっていたら、「保存されるのに xlsx に出ない」に戻っている。
   */
  it("★★ 非表示の区画も中身は組み立てている", () => {
    const form = buildOrderSheetForm(sheetWith());
    const plan = form.sections.find((section) => section.id === "productionPlan")!;
    expect(plan.fields.map((spec) => spec.ref)).toEqual([...PLAN_CELLS]);
    expect(plan.fields).toHaveLength(21);
    // ⚠ 見出しは `SHEET_HEADINGS` からの組み立て（対応表を増やさない）。
    expect(plan.fields[0]!.label).toBe("WAX Start");
    expect(plan.fields[20]!.label).toBe("FINAL QC+REPAIR Day");

    const customer = form.sections.find((section) => section.id === "customer")!;
    expect(customer.fields.map((spec) => spec.ref)).toEqual(["D12", "F12", "A12", "J12", "F5"]);
  });

  /**
   * ⚠⚠ **ヘッダの番地はどれか 1 つの区画に必ず入る。**
   *   足した番地がどこにも出ないと、「打てないのに保存はされる」欄が生まれる。
   */
  it("★★ ヘッダの番地に取りこぼしが無い", () => {
    const form = buildOrderSheetForm(sheetWith());
    const placed = form.sections.flatMap((section) => section.fields).map((spec) => spec.ref);
    expect([...placed].sort()).toEqual(
      [...HEADER_VALUE_CELLS, ...DERIVED_HEADER_CELLS].slice().sort(),
    );
    expect(new Set(placed).size).toBe(placed.length);
  });

  /** ⚠ 派生（取引先名・出力日）は打たせない。writer も同じ 3 つを捨てる。 */
  it("★ 派生のヘッダは打てない", () => {
    const form = buildOrderSheetForm(sheetWith());
    const customer = form.sections.find((section) => section.id === "customer")!;
    for (const spec of customer.fields) {
      expect(spec.editable, spec.ref).toBe(!DERIVED_HEADER_CELLS.includes(spec.ref));
    }
  });

  /** ⚠ `F5`（取引先名）は契約に無い。`A12` と同じ `partners.name` を出す。 */
  it("★ F5 は A12 と同じ値を出す", () => {
    const a12 = field("CUSTOMER: ACME");
    const form = buildOrderSheetForm(sheetWith(undefined, { A12: a12 }));
    const customer = form.sections.find((section) => section.id === "customer")!;
    expect(customer.fields.find((spec) => spec.ref === "F5")!.field).toBe(a12);
  });
});

describe("打てるかどうか", () => {
  /**
   * ⚠⚠ **取り込み中は 1 欄も触らせない。** 読み取りの結果でセルが入れ替わる最中に
   *   人が書くと、書いた値が上書きされて消える。
   */
  it("★★ 取り込み中は 1 欄も打てない", () => {
    const form = buildOrderSheetForm(sheetWith(), true);
    for (const spec of allFields(form)) expect(spec.editable, spec.label).toBe(false);
    for (const section of form.sections) {
      for (const card of section.lines) expect(card.picture.deletable).toBe(false);
    }
  });

  /**
   * ⚠⚠ **仮の明細（`lineId` が空）は打たせない。** writer が捨てるので、
   *   打てても保存されず黙って消える。
   */
  it("★★ 仮の明細は打てない（取り込み中でなくても）", () => {
    const form = buildOrderSheetForm(sheetWith([{ lineId: "", lineNo: 1 }]));
    const card = cardOf(form, 1);
    for (const spec of cardFields(card)) expect(spec.editable, spec.label).toBe(false);
    expect(card.picture.deletable).toBe(false);
    // ⚠ カード自体は出す（読み取り中の塗り分けが回るように）。
    expect(card.title).toBe("明細 #1");
  });

  it("★ 明細があるときは打てる", () => {
    const form = buildOrderSheetForm(sheetWith());
    for (const spec of cardFields(cardOf(form, 1))) expect(spec.editable, spec.label).toBe(true);
    expect(cardOf(form, 1).picture.deletable).toBe(true);
  });
});

/**
 * ★★ ヘッダは**入力欄の前に印字の接頭辞**を出す（xlsx の 1 セルと同じ文字になるように）。
 * ⚠ 接頭辞は値に入れない（`field.value` は打った文字だけ）。
 */
describe("★★ ヘッダの接頭辞", () => {
  it("SHIP と Customer PO は接頭辞を持ち、値には混ぜない", () => {
    const form = buildOrderSheetForm(
      sheetWith(undefined, { J5: field("10月上旬"), J7: field("F10009999") }),
    );
    const specs = new Map(allFields(form).map((spec) => [spec.ref, spec]));
    expect(specs.get("J5")!.prefix).toBe("SHIP : ");
    expect(specs.get("J7")!.prefix).toBe("Customer PO : ");
    expect(specs.get("J5")!.field.value).toBe("10月上旬");
    // 非表示の区画も同じ規則（xlsx には出るので）。
    expect(specs.get("D12")!.prefix).toBe("PO: ");
    expect(specs.get("F12")!.prefix).toBe("SO: ");
    expect(specs.get("A12")!.prefix).toBe("CUSTOMER: ");
    expect(specs.get("J12")!.prefix).toBe("DATE : ");
  });

  it("⚠ 明細・工程表・取引先名（F5）には接頭辞が無い（xlsx でも値だけが入る）", () => {
    const form = buildOrderSheetForm(sheetWith());
    for (const spec of allFields(form)) {
      if (["J5", "J7", "D12", "F12", "A12", "J12"].includes(spec.ref)) continue;
      expect(spec.prefix, spec.ref).toBeUndefined();
    }
  });

  /** ⚠ 日付の記入例は実例の書き方（`d/m/yy`）。打った文字がそのまま xlsx に出るため。 */
  it("日付の記入例は実例の書き方（d/m/yy）", () => {
    const specs = new Map(allFields(buildOrderSheetForm(sheetWith())).map((s) => [s.ref, s]));
    expect(specs.get("J5")!.placeholder).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2}$/u);
    expect(specs.get("K16")!.placeholder).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2}$/u);
  });
});
