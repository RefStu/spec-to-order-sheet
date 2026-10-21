import { describe, expect, it } from "vitest";
import type { ClassifiedPage } from "../contract";
import { partsFromPages } from "./group-parts";

/**
 * ⚠⚠ **ここが「読み取りが何回走るか」の正。**
 *   分類が「依頼書が 2 枚」と言えば、読み取りは**必ず 2 回**走る。
 *   数え方をモデルに戻さないこと (まとめられた実行で 1 枚が落ちても誰も気づけない)。
 */

function page(
  no: number,
  docType: ClassifiedPage["docType"],
  options: { startsNewSheet?: boolean; confidence?: number } = {},
): ClassifiedPage {
  return {
    page: no,
    docType,
    headerQuote: null,
    startsNewSheet: options.startsNewSheet ?? true,
    confidence: options.confidence ?? 90,
  };
}

describe("partsFromPages", () => {
  it("発注書が 2 ページ続けば 1 つの部品にまとめる", () => {
    const parts = partsFromPages([page(1, "purchase_order"), page(2, "purchase_order")]);
    expect(parts).toEqual([{ role: "purchase_order", pages: [1, 2], confidence: 90 }]);
  });

  it("依頼書が 3 枚なら 3 つの部品になる (読み取りが 3 回走る)", () => {
    const parts = partsFromPages([
      page(1, "purchase_order"),
      page(2, "spec_sheet"),
      page(3, "spec_sheet"),
      page(4, "spec_sheet"),
    ]);
    expect(parts.filter((part) => part.role === "spec_sheet")).toHaveLength(3);
  });

  /** ⚠ 1 枚が 2 ページにまたがる様式。**枚数が狂わないこと**が要件。 */
  it("続きのページ (startsNewSheet: false) は同じ枚に足す", () => {
    const parts = partsFromPages([
      page(1, "spec_sheet"),
      page(2, "spec_sheet", { startsNewSheet: false }),
      page(3, "spec_sheet"),
      page(4, "spec_sheet", { startsNewSheet: false }),
    ]);
    expect(parts).toEqual([
      { role: "spec_sheet", pages: [1, 2], confidence: 90 },
      { role: "spec_sheet", pages: [3, 4], confidence: 90 },
    ]);
  });

  /**
   * ⚠⚠ **モデルが全部 false を返しても 0 枚にしない。**
   *   安全側は「多めに数える」ではなく「**取りこぼさない**」。
   */
  it("⚠⚠ 最初の依頼書は startsNewSheet が false でも 1 枚目として立つ", () => {
    const parts = partsFromPages([
      page(1, "purchase_order"),
      page(2, "spec_sheet", { startsNewSheet: false }),
    ]);
    expect(parts.filter((part) => part.role === "spec_sheet")).toEqual([
      { role: "spec_sheet", pages: [2], confidence: 90 },
    ]);
  });

  it("other のページは部品にしない (読まない)", () => {
    const parts = partsFromPages([page(1, "other"), page(2, "purchase_order"), page(3, "other")]);
    expect(parts).toEqual([{ role: "purchase_order", pages: [2], confidence: 90 }]);
  });

  /** ⚠ 間に別の紙が挟まれば、同じ種類でも別の部品にする。 */
  it("other を挟んだ発注書は 2 つの部品になる", () => {
    const parts = partsFromPages([
      page(1, "purchase_order"),
      page(2, "other"),
      page(3, "purchase_order"),
    ]);
    expect(parts.map((part) => part.pages)).toEqual([[1], [3]]);
  });

  /** ⚠ モデルは順序を崩して返すことがある。 */
  it("ページが降順で来ても昇順に並べ直す", () => {
    const parts = partsFromPages([page(3, "purchase_order"), page(1, "purchase_order")]);
    expect(parts).toEqual([{ role: "purchase_order", pages: [1, 3], confidence: 90 }]);
  });

  it("確信度は部品の中でいちばん低い値にする", () => {
    const parts = partsFromPages([
      page(1, "purchase_order", { confidence: 90 }),
      page(2, "purchase_order", { confidence: 40 }),
    ]);
    expect(parts[0]?.confidence).toBe(40);
  });

  it("1 ページも無ければ空の配列 (落ちない)", () => {
    expect(partsFromPages([])).toEqual([]);
  });

  it("どのページも other なら部品は 0 件 (読み取りは走らない)", () => {
    expect(partsFromPages([page(1, "other"), page(2, "other")])).toEqual([]);
  });
});
