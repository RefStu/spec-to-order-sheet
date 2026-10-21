import { describe, expect, it } from "vitest";
import { fieldSchema, orderSheetSchema, patchOrderSheetInput } from "./schema";

/**
 * ★ 画面と Worker の接点なので、形を固定する。
 *   ここが通らなくなったら、画面 (features/cases) が黙って壊れる。
 */

const aiField = {
  value: "顧客A",
  // ★ 本来どちらが埋める欄か。filledBy (実際に誰が埋めたか) とは別物。
  by: "ai" as const,
  filledBy: "ai" as const,
  confidence: 0.97,
  corrected: false,
  source: { page: 1, bbox: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number] },
};

describe("Field — API の契約の型", () => {
  it("AI が埋めた欄", () => {
    expect(fieldSchema.parse(aiField)).toEqual(aiField);
  });

  it("まだ誰も入れていない欄 (filledBy = null) も通る", () => {
    const blank = {
      value: null,
      by: "human" as const,
      filledBy: null,
      confidence: null,
      corrected: false,
      source: null,
    };
    expect(fieldSchema.parse(blank)).toEqual(blank);
  });

  it("filledBy は ai / human / null の 3 つだけ", () => {
    expect(fieldSchema.safeParse({ ...aiField, filledBy: "system" }).success).toBe(false);
  });

  it("value は文字列 / 数値 / null", () => {
    expect(fieldSchema.safeParse({ ...aiField, value: 24 }).success).toBe(true);
    expect(fieldSchema.safeParse({ ...aiField, value: null }).success).toBe(true);
    expect(fieldSchema.safeParse({ ...aiField, value: true }).success).toBe(false);
  });
});

describe("PATCH の入力 — 直した欄だけが載る", () => {
  // ⚠ zod 4 の z.record(z.enum(...)) は全キー必須になる。欄の部分更新が通らなくなるので
  //   partialRecord でなければならない。ここが落ちたら PATCH の保存が 400 になる。
  it("ヘッダの欄を 1 つだけ送れる", () => {
    const parsed = patchOrderSheetInput.parse({ header: { J5: "2026-12-01" }, corrections: [] });
    expect(parsed.header).toEqual({ J5: "2026-12-01" });
  });

  it("明細のセルを 1 つだけ送れる", () => {
    const parsed = patchOrderSheetInput.parse({
      // ⚠ 鍵は xlsx の番地。`"B16"` = 1 件目の枠の B 列 (Code)。
      lines: [{ lineId: "L1", cells: { B16: "CM-A-1001" } }],
      corrections: [],
    });
    expect(parsed.lines?.[0]?.cells).toEqual({ B16: "CM-A-1001" });
  });

  /** ⚠ 知らない鍵を黙って受けない (雛形に無い番地に書こうとする事故を入口で止める)。 */
  it("⚠ セルの鍵でないものは断る", () => {
    // ⚠ 昔の相対の鍵 (`"F:0"`) も、もう通さない（世代を混ぜない）。
    for (const key of ["CODE", "F:0", "A16", "E16", "F87", "F"]) {
      const parsed = patchOrderSheetInput.safeParse({
        lines: [{ lineId: "L1", cells: { [key]: "x" } }],
        corrections: [],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("corrections は省略できる (既定は空)", () => {
    expect(patchOrderSheetInput.parse({}).corrections).toEqual([]);
  });

  it("AI の欄を直したときの記録を載せられる (正答率の分母)", () => {
    const parsed = patchOrderSheetInput.parse({
      lines: [{ lineId: "L1", cells: { H16: "12" } }],
      corrections: [
        {
          // ⚠ 直した欄の名前も**セルの鍵**（明細の場合）。
          fieldKey: "H16",
          lineId: "L1",
          previousValue: "11",
          newValue: "12",
          errorKind: "ocr",
        },
      ],
    });
    expect(parsed.corrections).toHaveLength(1);
    expect(parsed.corrections[0]?.errorKind).toBe("ocr");
  });

  it("知らない欄のキーは受け付けない", () => {
    expect(patchOrderSheetInput.safeParse({ header: { UNKNOWN: "x" } }).success).toBe(false);
  });
});

describe("ORDER SHEET の返り値", () => {
  it("欄が一部しか無くても通る (AI が書かない欄がある方が正しい)", () => {
    const sheet = {
      caseId: "c1",
      orderSheetId: "os1",
      status: "ai_generated",
      confidenceThreshold: 0.7,
      header: { A12: aiField },
      lines: [
        {
          lineId: "L1",
          lineNo: 1,
          picture: { ...aiField, value: null },
          cells: { I16: { ...aiField, value: 24 } },
        },
      ],
      productionPlan: [],
      issues: [],
    };
    expect(orderSheetSchema.safeParse(sheet).success).toBe(true);
  });
});
