import { describe, expect, it } from "vitest";
import type { Field } from "./order-sheet-contract";
import { fieldTone } from "./field-style";

const THRESHOLD = 0.7;

function field(patch: Partial<Field>): Field {
  return {
    value: "x",
    // 既定は「AI が埋める欄」。人の欄の試験は patch で by を渡す。
    by: "ai",
    filledBy: null,
    confidence: null,
    corrected: false,
    source: null,
    ...patch,
  };
}

describe("fieldTone — 塗り分けの 4 通り", () => {
  it("AI が埋めた欄", () => {
    expect(fieldTone(field({ filledBy: "ai", confidence: 0.95 }), THRESHOLD)).toBe("ai");
  });

  it("確信度が閾値未満なら警告", () => {
    expect(fieldTone(field({ filledBy: "ai", confidence: 0.42 }), THRESHOLD)).toBe(
      "ai-low-confidence",
    );
  });

  it("閾値ちょうどは警告にしない", () => {
    expect(fieldTone(field({ filledBy: "ai", confidence: THRESHOLD }), THRESHOLD)).toBe("ai");
  });

  it("人が直した欄は、確信度が低くても『直した印』が勝つ", () => {
    const f = field({ filledBy: "ai", confidence: 0.1, corrected: true });
    expect(fieldTone(f, THRESHOLD)).toBe("ai-corrected");
  });

  it("人が入れた欄", () => {
    expect(fieldTone(field({ filledBy: "human" }), THRESHOLD)).toBe("human");
  });

  it("filledBy が null = まだ誰も入れていない (人が埋める欄)", () => {
    expect(fieldTone(field({ filledBy: null, value: null }), THRESHOLD)).toBe("empty");
  });

  // ★ これが壊れると 8 欄 / 6 欄の定義が画面側にも生まれる。
  it("欄のキーを受け取らない (どの欄が AI かを画面が知らないことの担保)", () => {
    expect(fieldTone.length).toBe(2);
  });

  it("同じ Field なら、どの欄のものでも同じ結果になる", () => {
    const ai = field({ filledBy: "ai", confidence: 0.9 });
    // CODE (人の欄) の位置に AI の Field が来ても、判定は filledBy だけで決まる。
    expect(fieldTone(ai, THRESHOLD)).toBe(fieldTone({ ...ai }, THRESHOLD));
  });
});

describe("★ 取り込み中のスピナー", () => {
  // ⚠⚠ **欄のキーの一覧を画面に持たせない。** AI の欄かどうかは API が返す `by` で決まる。
  it("取り込み中で、AI が埋めるはずの空欄は loading", () => {
    expect(fieldTone(field({ by: "ai", filledBy: null }), THRESHOLD, true)).toBe("loading");
  });

  it("⚠ 人が埋める空欄は回さない (いつまでも埋まらない)", () => {
    expect(fieldTone(field({ by: "human", filledBy: null }), THRESHOLD, true)).toBe("empty");
  });

  it("⚠ 既に AI が埋めた欄は回さない", () => {
    expect(fieldTone(field({ by: "ai", filledBy: "ai", confidence: 0.9 }), THRESHOLD, true)).toBe(
      "ai",
    );
  });

  it("取り込みが終わっていれば回さない", () => {
    expect(fieldTone(field({ by: "ai", filledBy: null }), THRESHOLD, false)).toBe("empty");
  });

  it("既定は取り込み中ではない (第 3 引数を省いても壊れない)", () => {
    expect(fieldTone(field({ by: "ai", filledBy: null }), THRESHOLD)).toBe("empty");
  });
});
