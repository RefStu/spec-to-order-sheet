import { describe, expect, it } from "vitest";
import type { Field, Issue, OrderSheet } from "../schema";
import { collectIssues, judgeApproval } from "./approval";

/**
 * 承認の重さを固定する。**人が埋める欄はすべて warning。**
 *
 * ⚠⚠ **重さを変えるときは、このテストの diff で意図を示すこと。**
 *   `blocker` が 1 件でも戻ると承認が 409 で断られるようになり、**通しが止まる**。
 *   「人が確認して空欄でいいとした欄は通す」という判断を、コードの上で 1 か所に固定するのが
 *   このファイルの目的。
 * ⚠ 判定を持ってよいのは services/approval.ts だけ。画面側に写さない。
 */

const filled: Field = {
  value: "なにか",
  by: "human",
  filledBy: "human",
  confidence: null,
  corrected: false,
  source: null,
};

const blank = { ...filled, value: null, filledBy: null } as const;

/** 人が埋める欄がすべて空の ORDER SHEET (AI が起こした直後の状態)。 */
function emptySheet(): Pick<OrderSheet, "header" | "lines"> {
  return {
    header: {},
    // ⚠ 代表の図は判定に関係しない (人が埋める欄ではない)。
    lines: [{ lineId: "osl-1", lineNo: 1, photos: [], picture: blank, cells: {} }],
  };
}

const severityOf = (issues: Issue[], kind: string) =>
  issues.filter((issue) => issue.kind === kind).map((issue) => issue.severity);

describe("collectIssues — 人が埋める欄の重さ", () => {
  const issues = collectIssues(emptySheet());

  it.each([
    ["ship_date_missing", "出荷日 (SHIP)"],
    ["code_not_assigned", "社内品番 (Code)"],
    ["numbers_not_issued", "ID と PO / SO"],
  ])("%s は warning (%s)", (kind) => {
    const found = severityOf(issues, kind);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((severity) => severity === "warning")).toBe(true);
  });

  it("blocker は 1 件も出ない (これが入ると承認が 409 で止まる)", () => {
    expect(issues.filter((issue) => issue.severity === "blocker")).toEqual([]);
  });

  /**
   * ⚠⚠ **明細の Ship date は人の欄になった** (出どころが確定できないので読み取りをやめた)。
   *   ヘッダの SHIP と同じ `kind` だが、**別の欄**なので行を名指しして別に出る。
   */
  it("明細の Ship date も空なら warning で出る (ヘッダの SHIP とは別の指摘)", () => {
    const shipIssues = issues.filter((issue) => issue.kind === "ship_date_missing");
    expect(shipIssues).toHaveLength(2);
    expect(shipIssues.map((issue) => issue.lineId).sort()).toEqual([null, "osl-1"]);
    expect(shipIssues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("ヘッダの指摘は lineId を持たず、明細の指摘は行を名指しする", () => {
    const ship = issues.find((issue) => issue.kind === "ship_date_missing" && !issue.lineId);
    expect(ship?.lineId).toBeNull();

    const code = issues.find((issue) => issue.kind === "code_not_assigned");
    expect(code?.lineId).toBe("osl-1");
    expect(code?.message).toContain("1 行目");
  });

  it("欄が埋まっていれば指摘は出ない", () => {
    const none = collectIssues({
      header: { J5: filled, D12: filled, F12: filled },
      lines: [
        {
          lineId: "osl-1",
          lineNo: 1,
          photos: [],
          picture: blank,
          /*
           * ⚠ 明細は**セルの番地**で持つ。`"B16"` = Code、`"C16"` = ID、`"K16"` = Ship date。
           * ⚠ Ship date も人の欄 (読み取りをやめた)。埋まっていれば指摘は出ない。
           */
          cells: { B16: filled, C16: filled, K16: filled },
        },
      ],
    });
    expect(none).toEqual([]);
  });

  /**
   * ⚠⚠ AI の欄は空でも指摘しない。**読めない欄が空なのは正常**。
   *   Picture と REMARK は AI の欄になったので、ここから外してある。
   */
  it("⚠ AI が埋める欄 (写真・REMARK) は空でも指摘しない", () => {
    const kinds = issues.map((issue) => issue.kind);
    expect(kinds).not.toContain("photo_missing");
    expect(kinds).not.toContain("plan_missing");
  });

  it("空文字は空として扱う (null と同じ)", () => {
    const blank: Field = { ...filled, value: "" };
    const withBlank = collectIssues({ header: { J5: blank }, lines: [] });
    expect(severityOf(withBlank, "ship_date_missing")).toEqual(["warning"]);
  });
});

describe("judgeApproval", () => {
  it("6 欄が空でも通す (warning は承認を止めない)", () => {
    const { ok, blockers, warnings } = judgeApproval(collectIssues(emptySheet()));
    expect(ok).toBe(true);
    expect(blockers).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  /**
   * ⚠ blocker を戻せるようにしておく。「PoC では止めない」であって
   *   「二度と止めない」ではない (工程表の自動逆算が入ると SHIP は効き始める)。
   */
  it("blocker が 1 件でもあれば断る (重さを戻したときのため)", () => {
    const { ok, blockers } = judgeApproval([
      { kind: "ship_date_missing", severity: "blocker", message: "x", lineId: null },
      { kind: "photo_missing", severity: "warning", message: "y", lineId: null },
    ]);
    expect(ok).toBe(false);
    expect(blockers).toHaveLength(1);
  });
});
