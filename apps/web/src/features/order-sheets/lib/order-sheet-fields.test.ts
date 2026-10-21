import { describe, expect, it } from "vitest";
import {
  ORDER_SHEET_FIELDS,
  aiFieldTargets,
  aiLineCellRefs,
  fieldKeyOfTarget,
  isAiField,
  targetColumnOf,
} from "./order-sheet-fields";

/**
 * ⚠ この検査は「実物の ORDER SHEET の欄と 1 文字もずれていないこと」を
 *   固定するためのもの。欄を増やしたり減らしたりすると、正答率も画面の塗り分けもずれる。
 * ⚠⚠ **REMARK と Picture は AI の欄**、**Ship date(明細) は人の欄** (出どころが確定できない)、
 *   **Stone も人の欄** (石の読み取りをやめた)。工程表は欄ではなく人が打つセル (`C4:E10`)。
 *   いまは **AI 8 欄 / 人 6 欄**。
 */
describe("ORDER_SHEET_FIELDS", () => {
  it("AI が埋めるのはちょうど 8 欄", () => {
    const ai = Object.values(ORDER_SHEET_FIELDS).filter((f) => f.by === "ai");
    expect(ai.map((f) => f.label).sort()).toEqual(
      [
        "CUSTOMER",
        "CUSTOMER PO / NO",
        "Code master",
        "Description",
        "Picture",
        "QTY",
        "REMARK",
        "Size",
      ].sort(),
    );
    expect(ai).toHaveLength(8);
  });

  it("人と社内システムが埋めるのは 6 欄 (PO と SO は 1 つの欄を 2 列で持つ)", () => {
    const human = Object.values(ORDER_SHEET_FIELDS).filter((f) => f.by === "human");
    expect(new Set(human.map((f) => (f.label === "SO" ? "PO" : f.label))).size).toBe(6);
  });

  /**
   * ⚠⚠ **Stone は人の欄。** AI の読み取りから石を外した。
   *   **欄そのものは残す** (紙の G 列があり、人が入れる)。ここが `ai` に戻ると、
   *   `order-sheet-generator.ts` が空の値で人の入力を上書きし始める。
   */
  it("⚠⚠ Stone は人の欄 (AI は埋めない)", () => {
    expect(ORDER_SHEET_FIELDS.stone).toEqual({
      table: "order_sheet_lines",
      // ⚠  `order_sheet_line_stones` から**紙の G 列のセル**へ移した。
      column: "G",
      by: "human",
      label: "Stone",
    });
    expect(isAiField("stone")).toBe(false);
  });

  it("⚠ 工程表は欄に入っていない (人が打つヘッダのセル C4:E10 として扱う)", () => {
    const columns: string[] = Object.values(ORDER_SHEET_FIELDS).map((f) => f.column);
    const labels: string[] = Object.values(ORDER_SHEET_FIELDS).map((f) => f.label);
    expect(columns).not.toContain("planned_start_on");
    expect(labels).not.toContain("PRODUCTION PLAN");
  });

  it("⚠ Unit は入っていない (読み取りではなく固定値)", () => {
    const columns: string[] = Object.values(ORDER_SHEET_FIELDS).map((f) => f.column);
    expect(columns).not.toContain("unit_code");
  });

  it("⚠ AI が書いてはいけない欄が ai になっていない", () => {
    // 「埋まらない欄がある方が正しい」。ここが ai になると PoC の仕様が崩れる。
    for (const key of [
      "code",
      "internalId",
      "poNo",
      "soNo",
      "ship",
      "shipDate",
      "stone",
    ] as const) {
      expect(isAiField(key)).toBe(false);
    }
  });

  it("⚠ 明細の Ship date とヘッダの SHIP は別の列", () => {
    // ⚠⚠ **どちらも人の欄になったが、別の表の別の列。** 1 つにまとめない。
    expect(ORDER_SHEET_FIELDS.shipDate).toEqual({
      table: "order_sheet_lines",
      // 明細の Ship date は紙の K 列。
      column: "K",
      by: "human",
      label: "Ship date",
    });
    expect(ORDER_SHEET_FIELDS.ship).toEqual({
      table: "order_sheets",
      column: "J5",
      by: "human",
      label: "SHIP",
    });
  });

  it("aiFieldTargets が正答率の分母に使う (表, 鍵) を返す", () => {
    const targets = aiFieldTargets();
    expect(targets).toHaveLength(8);
    expect(targets).toContainEqual({ table: "order_sheet_lines", key: "codeMaster" });
    expect(targets).toContainEqual({ table: "order_sheet_lines", key: "picture" });
    // ⚠⚠ **出荷日は分母に入らない。** 人の欄なので正答率を測る対象ではない。
    expect(targets).not.toContainEqual({ table: "order_sheet_lines", key: "shipDate" });
    // ⚠⚠ **石も分母に入らない** (人の欄へ移した)。
    expect(targets).not.toContainEqual({ table: "order_sheet_lines", key: "stone" });
  });

  /**
   * ⚠⚠ **番地は明細ごとに解決する。** `column` は列の記号だけなので、
   *   ここを取り違えると**全部の明細が 1 行目の番地になる**。
   */
  it("★★ 明細の住所は行ごとに解決される", () => {
    expect(targetColumnOf("codeMaster", 0)).toBe("D16");
    expect(targetColumnOf("codeMaster", 1)).toBe("D22");
    expect(targetColumnOf("remark", 11)).toBe("L82");
    // ヘッダは 1 つしかないので番地のまま。
    expect(targetColumnOf("customerPoNo")).toBe("J7");
    expect(targetColumnOf("ship")).toBe("J5");
    // セルではない欄は物理の列名のまま。
    expect(targetColumnOf("picture")).toBe("photo_file_id");
    expect(targetColumnOf("customer")).toBe("partner_id");
    // ⚠ 明細の欄で行を渡し忘れたら落とす（列の記号のまま保存させない）。
    expect(() => targetColumnOf("codeMaster")).toThrow();
  });

  it("★ AI が埋める明細のセルは、その明細の番地で並ぶ", () => {
    expect(aiLineCellRefs(0)).toEqual(["D16", "F16", "H16", "I16", "L16"]);
    expect(aiLineCellRefs(1)).toEqual(["D22", "F22", "H22", "I22", "L22"]);
  });

  /**
   * ⚠⚠ **来歴の行は書き換えない運用**なので、`ai_extraction_fields` には世代の違う
   *   文字列が混ざっている。**どれも引けること**が 正答率の分母を保つ条件。
   *   ここが落ちたら、率が静かに下振れする。
   */
  it("★★ 来歴の列は、いまの形も昔の形も引ける", () => {
    // いま（絶対番地）。
    expect(fieldKeyOfTarget("order_sheet_lines", "D16")).toBe("codeMaster");
    expect(fieldKeyOfTarget("order_sheet_lines", "D22")).toBe("codeMaster");
    // その前（相対の鍵）。
    expect(fieldKeyOfTarget("order_sheet_lines", "D:0")).toBe("codeMaster");
    // それ以前（物理の列名）。
    expect(fieldKeyOfTarget("order_sheet_lines", "customer_item_code_text")).toBe("codeMaster");
    expect(fieldKeyOfTarget("order_sheet_lines", "quantity")).toBe("qty");
    expect(fieldKeyOfTarget("order_sheets", "customer_po_no")).toBe("customerPoNo");
    // ヘッダのいまの形。
    expect(fieldKeyOfTarget("order_sheets", "J7")).toBe("customerPoNo");
    // ⚠ 継ぎ行は欄ではない（原型No は人のセル）。
    expect(fieldKeyOfTarget("order_sheet_lines", "D17")).toBeUndefined();
    // ⚠ 表が違えば引けない（ヘッダの SHIP と明細の Ship date を取り違えない）。
    expect(fieldKeyOfTarget("order_sheet_lines", "J5")).toBeUndefined();
  });
});
