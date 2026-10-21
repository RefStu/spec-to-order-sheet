import {
  ORDER_SHEET_FIELDS,
  targetColumnOf,
  type OrderSheetFieldKey,
} from "../lib/order-sheet-fields";
import type { Field, Issue, OrderSheet } from "../schema";

/**
 * ORDER SHEET を現場に流せるかの判定。**ここ 1 か所だけが知っている。**
 *
 * **人が埋める欄はすべて warning。** 人が確認して空欄でいいとした欄は、空欄のまま通す。
 *   空欄を止めるのは人の確認であって、システムではない。
 * ⚠ **AI が埋める欄はここに入れない。** 空でも止めないし、指摘も出さない
 *   (読めない欄が空なのは正常)。Picture は AI の欄になったので外した。
 *
 * ⚠ **この表を直すときは、重さを変える意図があることをテストの diff で示すこと**
 *   (services/approval.test.ts が 1 件ずつ固定している)。
 * ⚠⚠ blocker が 1 件も無くなったので、**承認を呼べば必ず `released` になる** (不可逆点)。
 * ⚠⚠ **画面に承認ボタンは無い。** API (`POST /:caseId/approve`) は残して
 *   あるので、ここは**呼ばれなくなっただけで壊れていない**。戻すときはここを読むこと。
 * ⚠ **画面側に同じ判定を書かないこと。** 2 か所になると必ずずれる。
 */
const HEADER_SEVERITY: Record<
  string,
  { severity: Issue["severity"]; kind: string; label: string }
> = {
  // 工程は出荷日から逆算するので、空だと工程表が引けない。**それでも止めない**。
  // ⚠ 鍵は**セルの番地**。`SHIP` → `J5` / `PO` → `D12` / `SO` → `F12`。
  [ORDER_SHEET_FIELDS.ship.column]: {
    severity: "warning",
    kind: "ship_date_missing",
    label: "出荷日 (SHIP)",
  },
  // PoC は手入力で迂回している。⚠ PO と SO は別の欄なので、指摘も別に出す。
  [ORDER_SHEET_FIELDS.poNo.column]: {
    severity: "warning",
    kind: "numbers_not_issued",
    label: "PO",
  },
  [ORDER_SHEET_FIELDS.soNo.column]: {
    severity: "warning",
    kind: "numbers_not_issued",
    label: "SO",
  },
};

/**
 * 明細の欄の重さ。
 *
 * ⚠⚠ **番地を直接は書けない**。番地は行番号を含むので `"B16"` と書くと
 *   1 行目しか見なくなる。**欄の鍵で持ち、番地は行ごとに `targetColumnOf()` で解決する。**
 * ⚠ 鍵を書き写さないよう `ORDER_SHEET_FIELDS` から取るのは前と同じ
 *   — 紙の形が変わってもここは付いてくる。
 */
const LINE_RULES: {
  fieldKey: OrderSheetFieldKey;
  severity: Issue["severity"];
  kind: string;
  label: string;
}[] = [
  {
    fieldKey: "code",
    severity: "warning",
    kind: "code_not_assigned",
    label: "社内品番 (Code)",
  },
  {
    fieldKey: "internalId",
    severity: "warning",
    kind: "numbers_not_issued",
    label: "ID",
  },
  /**
   * ⚠⚠ **明細の Ship date は人の欄になった** (出どころが確定できないので読み取りをやめた)。
   *   人が埋める欄はすべて warning。**それでも止めない。**
   * ⚠ ヘッダの `SHIP` とは**別の欄**。同じ `kind` を使うが、出るのは行ごと。
   */
  {
    fieldKey: "shipDate",
    severity: "warning",
    kind: "ship_date_missing",
    label: "出荷日 (Ship date)",
  },
];

function isEmpty(field: Field | undefined): boolean {
  if (!field) return true;
  return field.value === null || field.value === "";
}

/** 空の欄から不整合の一覧を作る。 */
export function collectIssues(sheet: Pick<OrderSheet, "header" | "lines">): Issue[] {
  const issues: Issue[] = [];

  for (const [key, rule] of Object.entries(HEADER_SEVERITY)) {
    if (isEmpty(sheet.header[key as keyof typeof sheet.header])) {
      issues.push({
        kind: rule.kind,
        severity: rule.severity,
        message: `${rule.label} が未入力です`,
        lineId: null,
      });
    }
  }

  for (const [lineIndex, line] of sheet.lines.entries()) {
    for (const rule of LINE_RULES) {
      // ⚠ 番地はその明細のもの（`"B16"` / `"B22"` …）。
      if (isEmpty(line.cells[targetColumnOf(rule.fieldKey, lineIndex)])) {
        issues.push({
          kind: rule.kind,
          severity: rule.severity,
          message: `${line.lineNo} 行目の ${rule.label} が未入力です`,
          lineId: line.lineId,
        });
      }
    }
  }

  return issues;
}

/**
 * blocker が 1 件でも残っていれば承認させない。
 * warning だけなら承認できる — ただし**残ったまま画面に見える**のが条件。
 *
 * ⚠ 上の表に blocker が無いので、いまは常に `ok: true` になる。
 *   **この関数は消さない。** 重さの割り当てを変えれば blocker は戻る。
 */
export function judgeApproval(issues: Issue[]): {
  ok: boolean;
  blockers: Issue[];
  warnings: Issue[];
} {
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { ok: blockers.length === 0, blockers, warnings };
}
