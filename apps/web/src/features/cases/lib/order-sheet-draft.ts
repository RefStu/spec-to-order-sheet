import type { SaveOrderSheetInput } from "../hooks/use-cases";
import type { Correction, Field, FieldValue, OrderSheet } from "./order-sheet-contract";
import { qtyNumberOf } from "./order-sheet-form";
import { cardFields, type FieldSpec, type OrderSheetForm } from "./order-sheet-sections";

/**
 * ★★ 下書き（画面で打ったが、まだ保存していない値）と、それを PATCH に畳む変換。
 *
 * ⚠⚠ **`OrderSheetPanel.tsx` から出した。挙動は 1 ミリも変えていない。**
 *   出した理由はただ 1 つ、**node で試せるようにする**ため
 *   （`apps/web/vitest.config.ts` は `environment: "node"` で、DOM のテストが 1 つも無い）。
 *   合計の数え落とし（下）のような不具合は、部品の中にあると誰も気づけなかった。
 * ⚠ **保存は PATCH 経由だけ。** ここは形を作るだけで、撃つのは `CaseDetailPage`。
 */

/**
 * 下書きの鍵。
 *
 * ⚠ **区切りはコロン 2 つ。** 番地にコロンは入らなくなった（`"F:0"` を
 *   やめて `"F16"` にした）が、`toSaveInput()` が `split("::")` で割るので**そのまま**。
 *   1 つに戻すと、将来また区切りを含む鍵が来たときに黙って割れる。
 */
export function draftKeyOf(scope: string, ref: string): string {
  return `${scope}::${ref}`;
}

/** 鍵は `draftKeyOf()` が作ったもの。`scope` は `"header"` か `lineId`。 */
export type Draft = Record<string, FieldValue>;

/** 下書きを重ねた欄。⚠ 打っていない欄は API が返した参照をそのまま返す（`memo` のため）。 */
export function withDraft(field: Field, draftValue: FieldValue | undefined): Field {
  return draftValue === undefined ? field : { ...field, value: draftValue };
}

/**
 * ★★ 下書きを PATCH の形に畳む。
 *
 * ⚠ **AI が埋めた欄を人が直したときだけ `corrections` に載せる**（正答率の分母）。
 *   人の欄の初回入力は「修正」ではない。
 * ⚠ 誤りの種類（`errorKind`）は画面では決めない。人に選ばせるのは次の段。
 * ⚠ 触っていない側は `undefined` にする（空の `{}` / `[]` を送らない）。
 */
export function toSaveInput(sheet: OrderSheet, draft: Draft): SaveOrderSheetInput {
  const header: Record<string, FieldValue> = {};
  // ⚠ 明細は**セルの番地 → 値**（`"F17"` など）。打ったセルだけが載る。
  const lineMap = new Map<string, Record<string, FieldValue>>();
  const corrections: Correction[] = [];

  for (const [key, newValue] of Object.entries(draft)) {
    const [scope, fieldKey] = key.split("::") as [string, string];
    const isHeader = scope === "header";
    const lineId = isHeader ? null : scope;
    const before: Field | undefined = isHeader
      ? sheet.header[fieldKey]
      : sheet.lines.find((line) => line.lineId === scope)?.cells[fieldKey];

    if (isHeader) header[fieldKey] = newValue;
    else {
      const entry = lineMap.get(scope) ?? {};
      entry[fieldKey] = newValue;
      lineMap.set(scope, entry);
    }

    if (before?.filledBy === "ai" && before.value !== newValue) {
      corrections.push({
        fieldKey,
        lineId,
        previousValue: before.value,
        newValue,
        errorKind: null,
      });
    }
  }

  return {
    header: Object.keys(header).length > 0 ? header : undefined,
    lines:
      lineMap.size > 0 ? [...lineMap].map(([lineId, cells]) => ({ lineId, cells })) : undefined,
    corrections,
  };
}

/**
 * ★ 合計本数（`G7` / `I<合計>` に出る数。2 件なら `I28`）。
 *
 * ⚠ **読み取った値ではない**ので欄にしない（実物は雛形の数式）。
 *   画面が出すのは「Excel を開かなくても同じ数字が見える」ためで、xlsx の数式は置き換えない
 *   （数式のキャッシュ値 `<v>` には同じ数が入る。`order-sheets/lib/order-sheet-xlsx.ts` の `totalQuantityOf()`）。
 * ⚠ 下書きを含めて数える（保存前でも画面の数字と合うように）。
 * ⚠⚠ **API が返さなかったセルも数えること。** `cells` は疎で、人の欄が空なら鍵ごと入っていない。
 *   `if (!field) return total;` とすると、**空だった QTY に
 *   打ち込んでも合計が動かなかった**。いまは記述子が QTY の欄を必ず持ち（無ければ
 *   `BLANK_CELL`）、その欄を引くので、数え落としが起きない。
 */
export function qtyTotalOf(form: OrderSheetForm, draft: Draft): number {
  let total = 0;
  for (const section of form.sections) {
    for (const card of section.lines) {
      const spec = cardFields(card).find((field) => field.ref === card.qtyRef);
      if (spec === undefined) continue;
      const value = withDraft(spec.field, draft[draftKeyOf(spec.scope, spec.ref)]).value;
      /*
       * ⚠⚠ **xlsx の `SUM` と同じ判定で数える。**xlsx は数に読める QTY だけを
       *   数値のセルにし、残りは文字のまま入れる。`Number()` で数えると `3.0` や `03`
       *   （xlsx では文字 = `SUM` に入らない）が**画面の合計にだけ**入る。
       */
      total += qtyNumberOf(value) ?? 0;
    }
  }
  return total;
}

/** 未保存の項目 1 つ（「xlsx で出す」の確認ダイアログに出す）。 */
export interface UnsavedItem {
  /** `draftKeyOf()` の鍵。 */
  key: string;
  /** `"明細 #2 / Description #2"` のような、画面の見出しと同じ呼び名。 */
  label: string;
  /** 保存済みの値（D1 = xlsx に出る値）。 */
  saved: FieldValue;
  /** 画面で打った値（まだ保存していない）。 */
  draft: FieldValue;
}

/** ⚠ 空文字と null は同じ「空」として比べる（空の欄に打って消しただけなら変更ではない）。 */
function sameValue(a: FieldValue, b: FieldValue): boolean {
  const norm = (v: FieldValue) => (v === null || v === undefined ? "" : String(v));
  return norm(a) === norm(b);
}

/**
 * ★★ まだ保存していない項目（保存済みの値と違う下書き）を、**画面の並び順**で返す。
 *
 * ⚠⚠ **「xlsx で出す」は D1 の保存済みの値から作る**（`order-sheets/services/order-sheet-export.ts`）。
 *   保存せずに出すと、画面で打った文字が xlsx に**黙って入らない**。
 *   そのため、保存ボタンの横の印と「xlsx で出す」の確認はこの一覧で決める。
 * ⚠ 打ってから元の値に戻した欄は含めない（出しても差は無い）。
 * ⚠ 画面に出していない区画も数える（下書きが入る経路は画面だけだが、取りこぼさない）。
 */
export function unsavedItemsOf(form: OrderSheetForm, draft: Draft): UnsavedItem[] {
  const items: UnsavedItem[] = [];
  const push = (prefix: string, spec: FieldSpec) => {
    const key = draftKeyOf(spec.scope, spec.ref);
    if (!(key in draft)) return;
    const value = draft[key] as FieldValue;
    if (sameValue(value, spec.field.value)) return;
    items.push({ key, label: `${prefix} / ${spec.label}`, saved: spec.field.value, draft: value });
  };
  for (const section of form.sections) {
    for (const spec of section.fields) push(section.title, spec);
    for (const card of section.lines) for (const spec of cardFields(card)) push(card.title, spec);
  }
  return items;
}
