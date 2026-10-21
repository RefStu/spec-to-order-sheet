import { describe, expect, it } from "vitest";
import { dedupeBoxes, MIN_BOX_CONFIDENCE, usableBox } from "./picture-box";

/**
 * ⚠⚠ **ここが「モデルの座標をそのまま信じない」の固定。**
 *   外れた枠で切ると、関係のない切れ端が写真の欄に入る。空のほうが正しい。
 */

const shape = { pageCount: 3, pageWidth: 1240, pageHeight: 1753 };
const box = (over: Partial<Parameters<typeof usableBox>[0]> = {}) => ({
  page: 2,
  x: 0.1,
  y: 0.6,
  width: 0.2,
  height: 0.12,
  confidence: 80,
  // ⚠ 足切りには使わない欄 (`contract.ts` の `labelQuote`)。既定は「語が読めなかった」。
  labelQuote: null,
  ...over,
});

describe("usableBox", () => {
  it("まともな枠はそのまま通る", () => {
    expect(usableBox(box(), shape)).toEqual({ x: 0.1, y: 0.6, width: 0.2, height: 0.12 });
  });

  /**
   * ⚠⚠ **いまは confidence で落とさない** (`MIN_BOX_CONFIDENCE = 0`)。
   *   実測で、**confidence は当たり外れを分けていなかった** (同じ 1 通の中で、
   *   ある依頼書は 60 でも命中し、別の依頼書は 68 でも外した)。
   *   外れが混じっても**とりあえず出して、人が画面で捨てる**方針に振ってある。
   * ⚠ このテストは「閾値を上げたら下は落ちる」という**関係**を固定するためのもの。
   *   `MIN_BOX_CONFIDENCE` を 70 に戻しても、ここは書き換えずに通る。
   */
  it("⚠ confidence の閾値より下は切らない (いまは閾値が 0 なので、実質すべて通る)", () => {
    expect(usableBox(box({ confidence: MIN_BOX_CONFIDENCE }), shape)).not.toBeNull();
    if (MIN_BOX_CONFIDENCE > 0) {
      expect(usableBox(box({ confidence: MIN_BOX_CONFIDENCE - 1 }), shape)).toBeNull();
    } else {
      // 閾値が 0 のときは「自信ゼロの枠でも切る」が期待される振る舞い。
      expect(usableBox(box({ confidence: 0 }), shape)).not.toBeNull();
    }
  });

  it("⚠ 無いページを指したら使わない", () => {
    expect(usableBox(box({ page: 0 }), shape)).toBeNull();
    expect(usableBox(box({ page: 4 }), shape)).toBeNull();
    expect(usableBox(box({ page: 1.5 }), shape)).toBeNull();
  });

  it("⚠ 数になっていない値は使わない", () => {
    expect(usableBox(box({ x: Number.NaN }), shape)).toBeNull();
    expect(usableBox(box({ height: Number.POSITIVE_INFINITY }), shape)).toBeNull();
  });

  it("⚠ 幅や高さが 0 以下なら使わない", () => {
    expect(usableBox(box({ width: 0 }), shape)).toBeNull();
    expect(usableBox(box({ height: -0.2 }), shape)).toBeNull();
  });

  it("⚠⚠ 大きく外へはみ出した枠は直さずに捨てる (当てずっぽうの可能性が高い)", () => {
    expect(usableBox(box({ x: -0.3 }), shape)).toBeNull();
    expect(usableBox(box({ x: 0.5, width: 0.8 }), shape)).toBeNull();
  });

  it("ほんの少しのはみ出しは詰める (1.0 を狙って超えた程度)", () => {
    const fixed = usableBox(box({ x: 0.8, width: 0.22 }), shape);
    expect(fixed!.x).toBe(0.8);
    expect(fixed!.width).toBeCloseTo(0.2, 10);
  });

  it("⚠ 小さすぎる / 大きすぎる枠は使わない (ゴミとページ全体を弾く)", () => {
    expect(usableBox(box({ width: 0.01, height: 0.01 }), shape)).toBeNull();
    expect(usableBox(box({ x: 0, y: 0, width: 1, height: 1 }), shape)).toBeNull();
  });

  it("⚠⚠ ページの下半分ごとは使わない (代表の図ではなく図の集まりを指している)", () => {
    // 実測: モデルはここを返していて、メッキ指示の図まで写真の欄に入っていた。
    expect(usableBox(box({ x: 0.05, y: 0.5, width: 0.9, height: 0.45 }), shape)).toBeNull();
  });

  it("実物の代表の図の大きさ (ページの 0.6 % 〜 1.5 %) は通る", () => {
    // 実測: 依頼書の「完成イメージ」のラベルの下にある図。
    expect(
      usableBox(box({ x: 0.335, y: 0.599, width: 0.097, height: 0.063 }), shape),
    ).not.toBeNull();
    expect(
      usableBox(box({ x: 0.081, y: 0.596, width: 0.234, height: 0.063 }), shape),
    ).not.toBeNull();
  });

  it("⚠ 縦横比が極端なら使わない (線や帯を指している)", () => {
    // 割合では 0.9 × 0.05 でも、用紙が縦長なので実寸ではさらに細長い。
    expect(usableBox(box({ x: 0, y: 0.5, width: 0.9, height: 0.03 }), shape)).toBeNull();
  });
});

/**
 * ⚠⚠ **複数枚を許した瞬間に要る検査。** 1 枚のころは構造的に起きなかったが、
 *   枠を複数受け取ると「同じ図を 2 回挙げる」実行が出る。
 */
describe("dedupeBoxes", () => {
  it("同じ座標の枠は 1 つに畳む", () => {
    expect(dedupeBoxes([box(), box()])).toHaveLength(1);
  });

  /** ⚠ 丸めるのは 3 桁。第 4 位までしか違わないものは「同じ図」とみなす。 */
  it("⚠ 小数第 4 位だけ違う枠も同じものとして畳む", () => {
    expect(dedupeBoxes([box(), box({ x: 0.10004 })])).toHaveLength(1);
  });

  it("第 3 位が違えば別の図として残す", () => {
    expect(dedupeBoxes([box(), box({ x: 0.102 })])).toHaveLength(2);
  });

  it("⚠ ページが違えば同じ座標でも残す (1 ページに依頼書が複数載る)", () => {
    expect(dedupeBoxes([box({ page: 1 }), box({ page: 2 })])).toHaveLength(2);
  });

  /** ⚠ 先に出たほうを残す (モデルが挙げた順 = 紙の上から順であることが多い)。 */
  it("⚠ 先に出たほうを残し、並びを変えない", () => {
    const first = box({ labelQuote: "完成イメージ" });
    const second = box({ labelQuote: "刻印位置" });
    const third = box({ x: 0.5, labelQuote: "完成イメージ" });
    expect(dedupeBoxes([first, second, third])).toEqual([first, third]);
  });

  /**
   * ⚠ 数になっていない枠はここでは捨てない。**捨てるのは `usableBox()` の仕事**で、
   *   ここが両方をやると「なぜ枠が消えたか」を追う場所が 2 つになる。
   */
  it("⚠ 数になっていない枠はここでは捨てない (usableBox の担当)", () => {
    expect(dedupeBoxes([box({ x: Number.NaN }), box({ x: Number.NaN })])).toHaveLength(2);
  });

  it("空なら空", () => {
    expect(dedupeBoxes([])).toEqual([]);
  });
});
