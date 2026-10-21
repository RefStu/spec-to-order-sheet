import { classifyPromptFor, type FormSection } from "./classify";
import {
  FORM1_CLASSIFY_NOTES,
  FORM1_PICTURE_NOTES,
  FORM1_PO_NOTES,
  FORM1_SPEC_NOTES,
} from "./forms/form1";
import { linkPrompt } from "./link";
import { pictureLocationPrompt } from "./picture-location";
import { purchaseOrderPrompt } from "./purchase-order";
import { specNotePrompt } from "./spec-note";
import { specSheetPrompt } from "./spec-sheet";

/**
 * ★★ **指示文の正はこのディレクトリ (= git)。**
 *
 * ⚠⚠ **DB (`ai_prompts`) から渡す仕組みはやめた。** 様式ごとの指示文を画面から差し替える形は、
 *   様式も欄も固まっていないうちは早すぎると判断した。戻すときは
 *   `docExtractRequest` に `prompts` を足し直すところから。
 * ⚠⚠ **`.md` を raw import しないこと。** `mastra build` は `.mastra/output` しか成果物に
 *   含めないので、**ビルドした成果物でだけプロンプトが空になる**。中身は `.ts` の文字列にする。
 */

/**
 * workflow のノード。**役割は閉じている** (様式が増えても増えない)。
 *
 * ⚠ `picture_location` は後から足した。増えたのは**役割**であって様式ではない
 *   (代表の図の座標を、欄の読み取りと**別の呼び出し**にしたため)。
 * ⚠ `spec_note` も後から足した (依頼書の下部のメモ。**将来は消す**)。
 */
export type PromptRole =
  | "classify"
  | "purchase_order"
  | "spec_sheet"
  | "picture_location"
  | "spec_note"
  | "link";

/**
 * 様式 1 つぶん。**本文は持たず、差分の注意書きだけを持つ。**
 *
 * ⚠ 本文 (どこから何を取るか) は様式によらないので `purchase-order.ts` / `spec-sheet.ts` にある。
 *   ここに本文を書き写すと、様式が 2 つ目になった時点で**同じ文を 2 か所で直す**ことになる。
 */
interface FormPrompts {
  name: string;
  /** 分類のノードに出す見分け方。 */
  classifyNotes: string;
  /** 発注書のノードに足す注意書き (無ければ空文字)。 */
  purchaseOrderNotes: string;
  /** 依頼書のノードに足す注意書き (無ければ空文字)。 */
  specSheetNotes: string;
  /** 代表の図の場所のノードに足す注意書き (無ければ空文字)。 */
  pictureNotes: string;
}

/**
 * ★★ **様式の一覧の正はここだけ。**
 *
 * 様式を増やすときに触るのは **この表**と **`prompts/forms/<code>.ts`** の 2 つだけで、
 * **`steps/` と `lib/` は 1 文字も変えない**。これが「様式ごとの分岐をコードに書かない」
 * の守り方。
 *
 * ⚠ code は **web の `partner_form_profiles.code` と同じ文字列**にしておく。
 *   いまは web がこの値を使っていないが、様式の管理を DB に戻すときに噛み合わなくなる。
 */
const FORM_PROMPTS = {
  FORM1: {
    name: "様式パターン①",
    classifyNotes: FORM1_CLASSIFY_NOTES,
    purchaseOrderNotes: FORM1_PO_NOTES,
    specSheetNotes: FORM1_SPEC_NOTES,
    pictureNotes: FORM1_PICTURE_NOTES,
  },
} as const satisfies Record<string, FormPrompts>;

export type FormCode = keyof typeof FORM_PROMPTS;

export const FORM_CODES = Object.keys(FORM_PROMPTS) as FormCode[];

/** 分類が返した code が一覧に載っているか。載っていなければ null (= 既定の経路)。 */
export function knownFormCode(code: string | null | undefined): FormCode | null {
  return typeof code === "string" && code in FORM_PROMPTS ? (code as FormCode) : null;
}

/**
 * 様式の呼び名。
 * ⚠ **モデルには答えさせない。** 名前の正を 1 か所に保つため、code から引く。
 */
export function formNameOf(code: string | null | undefined): string | null {
  const known = knownFormCode(code);
  return known === null ? null : FORM_PROMPTS[known].name;
}

/** 分類のノードに渡す様式の一覧。 */
function formSections(): FormSection[] {
  return FORM_CODES.map((code) => ({
    code,
    name: FORM_PROMPTS[code].name,
    notes: FORM_PROMPTS[code].classifyNotes,
  }));
}

/**
 * ★ そのノードに渡す指示文を決める。
 *
 * ⚠ `switch` は**役割**の分岐 (5 つで閉じている) であって、様式の分岐ではない。
 *   様式の分岐は `FORM_PROMPTS[form]` の索引 1 つに畳まれている。
 * ⚠⚠ **一覧に無い様式でも止めない。** 差分の注意書きが空のまま、共通の本文だけで読む
 *   (様式が未知でも「読めるものは読む」ほうが業務的に正しい)。
 */
export function promptFor(role: PromptRole, formCode: string | null): string {
  const form = knownFormCode(formCode);
  switch (role) {
    case "classify":
      return classifyPromptFor(formSections());
    case "purchase_order":
      return purchaseOrderPrompt(form === null ? "" : FORM_PROMPTS[form].purchaseOrderNotes);
    case "spec_sheet":
      return specSheetPrompt(form === null ? "" : FORM_PROMPTS[form].specSheetNotes);
    case "picture_location":
      return pictureLocationPrompt(form === null ? "" : FORM_PROMPTS[form].pictureNotes);
    case "spec_note":
      // ⚠ 様式の差分は持たせない (消すときに `forms/` を触らずに済むように)。
      return specNotePrompt();
    case "link":
      return linkPrompt();
  }
}
