import { describe, expect, it } from "vitest";
import type { Field, OrderSheet } from "./order-sheet-contract";
import {
  draftKeyOf,
  qtyTotalOf,
  toSaveInput,
  unsavedItemsOf,
  withDraft,
  type Draft,
} from "./order-sheet-draft";
import { BLANK_CELL, qtyRefOf } from "./order-sheet-form";
import { buildOrderSheetForm } from "./order-sheet-sections";

/**
 * ★★ 下書きと保存。**`OrderSheetPanel.tsx` から出した**ので、
 *   ここで初めて node で試せるようになった（DOM のテストはこのリポジトリに無い）。
 */

function field(value: string | number | null, over: Partial<Field> = {}): Field {
  return { ...BLANK_CELL, value, ...over };
}

function sheetWith(
  lines: { lineId: string; lineNo: number; cells?: Record<string, Field> }[],
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

describe("下書きの鍵", () => {
  /**
   * ⚠ **区切りはコロン 2 つ。** 番地にコロンは入らなくなったが、
   *   `toSaveInput()` が `split("::")` で割るのでそのまま。1 つに戻すと、
   *   将来また区切りを含む鍵が来たときに黙って割れる。
   */
  it("★ 区切りはコロン 2 つ", () => {
    expect(draftKeyOf("header", "J5")).toBe("header::J5");
    expect(draftKeyOf("line-1", "F20")).toBe("line-1::F20");
  });

  it("★ 打っていない欄は API が返した参照をそのまま返す", () => {
    const f = field("もとの値");
    expect(withDraft(f, undefined)).toBe(f);
    expect(withDraft(f, "打った値")).toEqual({ ...f, value: "打った値" });
  });
});

describe("保存の形", () => {
  it("★ ヘッダと明細を分けて畳む", () => {
    const sheet = sheetWith([{ lineId: "line-1", lineNo: 1 }]);
    const draft: Draft = {
      "header::J5": "28/4/99",
      "line-1::F20": "Logo SILVER",
      "line-1::I16": "3",
    };
    expect(toSaveInput(sheet, draft)).toEqual({
      header: { J5: "28/4/99" },
      lines: [{ lineId: "line-1", cells: { F20: "Logo SILVER", I16: "3" } }],
      corrections: [],
    });
  });

  /** ⚠ 触っていない側は `undefined`（空の `{}` / `[]` を送らない）。 */
  it("★ 触っていない側は undefined", () => {
    const sheet = sheetWith([{ lineId: "line-1", lineNo: 1 }]);
    expect(toSaveInput(sheet, { "header::D12": "9012345" }).lines).toBeUndefined();
    expect(toSaveInput(sheet, { "line-1::B16": "x" }).header).toBeUndefined();
    expect(toSaveInput(sheet, {})).toEqual({
      header: undefined,
      lines: undefined,
      corrections: [],
    });
  });

  /**
   * ⚠⚠ **AI が埋めた欄を人が直したときだけ記録する**（正答率の分母）。
   *   人の欄の初回入力は「修正」ではない。
   */
  it("★★ corrections は AI の欄を直したときだけ", () => {
    const sheet = sheetWith([
      {
        lineId: "line-1",
        lineNo: 1,
        cells: {
          F16: field("CASTING SV950", { filledBy: "ai", confidence: 0.9 }),
          G16: field(null), // 人の欄（まだ空）
          H16: field("#10", { filledBy: "human" }),
        },
      },
    ]);
    const out = toSaveInput(sheet, {
      "line-1::F16": "CASTING SV925",
      "line-1::G16": "(ダイヤモンド)",
      "line-1::H16": "#11",
    });
    expect(out.corrections).toEqual([
      {
        fieldKey: "F16",
        lineId: "line-1",
        previousValue: "CASTING SV950",
        newValue: "CASTING SV925",
        // ⚠ 誤りの種類は画面では決めない（人に選ばせるのは次の段）。
        errorKind: null,
      },
    ]);
  });

  it("★ AI の欄でも値が変わらなければ記録しない", () => {
    const sheet = sheetWith([
      { lineId: "line-1", lineNo: 1, cells: { F16: field("同じ", { filledBy: "ai" }) } },
    ]);
    expect(toSaveInput(sheet, { "line-1::F16": "同じ" }).corrections).toEqual([]);
  });
});

describe("合計本数", () => {
  /**
   * ⚠⚠ **API が返さなかったセルも数えること。** `cells` は疎で、人の欄が空なら
   *   鍵ごと入っていない。数え落とすと、**空だった QTY に
   *   打ち込んでも合計が動かない**。
   */
  it("★★ API が返さなかった QTY に打っても合計が動く", () => {
    const sheet = sheetWith([
      { lineId: "line-1", lineNo: 1 },
      { lineId: "line-2", lineNo: 2 },
    ]);
    const form = buildOrderSheetForm(sheet);
    expect(qtyTotalOf(form, {})).toBe(0);
    expect(qtyTotalOf(form, { [`line-1::${qtyRefOf(1)}`]: "3" })).toBe(3);
    expect(
      qtyTotalOf(form, { [`line-1::${qtyRefOf(1)}`]: "3", [`line-2::${qtyRefOf(2)}`]: "4" }),
    ).toBe(7);
  });

  it("★ 保存済みの値と下書きを合わせて数える", () => {
    const sheet = sheetWith([
      { lineId: "line-1", lineNo: 1, cells: { I16: field(5, { filledBy: "ai" }) } },
      { lineId: "line-2", lineNo: 2, cells: { I22: field(1, { filledBy: "ai" }) } },
    ]);
    const form = buildOrderSheetForm(sheet);
    expect(qtyTotalOf(form, {})).toBe(6);
    // ⚠ 下書きが勝つ（保存前でも画面の数字と合う）。
    expect(qtyTotalOf(form, { "line-1::I16": "2" })).toBe(3);
  });

  it("★ 数にならない値は数えない", () => {
    const sheet = sheetWith([{ lineId: "line-1", lineNo: 1, cells: { I16: field("あ") } }]);
    const form = buildOrderSheetForm(sheet);
    expect(qtyTotalOf(form, {})).toBe(0);
    expect(qtyTotalOf(form, { "line-1::I16": "いくつか" })).toBe(0);
  });

  /**
   * ★★ **xlsx の `SUM` と同じ数にする。**xlsx は「数値にしても同じ文字に見える」QTY だけを
   *   数値のセルにし、`3.0` / `03` / 全角の `３` は**文字のまま**入れる（`SUM` に入らない）。
   *   `Number()` で数えると画面の合計にだけ入ってずれる。
   */
  it("★★ xlsx で文字のまま入る QTY は、画面の合計にも入れない", () => {
    const sheet = sheetWith([
      { lineId: "line-1", lineNo: 1 },
      { lineId: "line-2", lineNo: 2 },
    ]);
    const form = buildOrderSheetForm(sheet);
    expect(qtyTotalOf(form, { "line-1::I16": "3.0", "line-2::I22": "2" })).toBe(2);
    expect(qtyTotalOf(form, { "line-1::I16": "03", "line-2::I22": "３" })).toBe(0);
    expect(qtyTotalOf(form, { "line-1::I16": "3個", "line-2::I22": "2.5" })).toBe(2.5);
  });
});

describe("まだ保存していない項目 (xlsx で出す前の確認)", () => {
  const sheet = sheetWith(
    [
      { lineId: "l1", lineNo: 1, cells: { F16: field("CASTING SV950", { filledBy: "ai" }) } },
      { lineId: "l2", lineNo: 2 },
    ],
    { J7: field("F10000001") },
  );
  const form = buildOrderSheetForm(sheet, false);

  it("下書きが無ければ空", () => {
    expect(unsavedItemsOf(form, {})).toEqual([]);
  });

  it("★ 明細の継ぎ行 (Description #2) も、見出しと明細の番号つきで返す", () => {
    const draft: Draft = { [draftKeyOf("l2", "F23")]: "鋳造のあと磨く" };
    expect(unsavedItemsOf(form, draft)).toEqual([
      {
        key: draftKeyOf("l2", "F23"),
        label: "明細 #2 / Description #2",
        saved: null,
        draft: "鋳造のあと磨く",
      },
    ]);
  });

  it("画面の並び順 (ヘッダ → 明細 #1 → #2) で返す", () => {
    const draft: Draft = {
      [draftKeyOf("l2", "F22")]: "CASTING K18",
      [draftKeyOf("l1", "F16")]: "CASTING PT900",
      [draftKeyOf("header", "J7")]: "F10009999",
    };
    expect(unsavedItemsOf(form, draft).map((item) => item.key)).toEqual([
      draftKeyOf("header", "J7"),
      draftKeyOf("l1", "F16"),
      draftKeyOf("l2", "F22"),
    ]);
  });

  it("⚠ 打ってから保存済みの値に戻した欄は含めない (空と null も同じ扱い)", () => {
    const draft: Draft = {
      [draftKeyOf("l1", "F16")]: "CASTING SV950",
      [draftKeyOf("l1", "F17")]: "",
    };
    expect(unsavedItemsOf(form, draft)).toEqual([]);
  });
});
