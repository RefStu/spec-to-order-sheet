import type { Field } from "./order-sheet-contract";

/**
 * ★★ ORDER SHEET の欄の塗り分け。**AI が埋めた欄と人が埋める欄を見分けるためのもの。**
 *
 * ⚠⚠ **「どの欄が AI で、どの欄が人か」のリストをここに持たない。**
 *   この関数は **欄のキーを受け取らない**。引数は Field 1 つと閾値だけ。
 *   持つと 8 欄 / 6 欄の定義が API と画面の 2 か所になり、必ずずれる。
 *
 * 見え方の表:
 *   色を敷いた欄  … AI が埋めた
 *   警告の色      … AI が埋めたが確信度が低い
 *   直した印      … AI が埋めたあと人が直した
 *   枠だけの欄    … 人が埋める (空なら「未入力」と分かるように)
 */
export type FieldTone = "ai" | "ai-low-confidence" | "ai-corrected" | "human" | "empty" | "loading";

/**
 * @param ingesting その案件が**まだ取り込み中**か (`useJobStatus` の progress が
 *   accepted / reading)。
 *
 * ⚠⚠ **「AI が埋める 8 欄」の一覧を画面に持たない**ために、
 *   *その欄が AI の欄かどうか*は **API が返す `field.by`** で判断する。
 *   ここで欄のキーを見たら、定義が API と 2 か所になって必ずずれる。
 */
export function fieldTone(field: Field, confidenceThreshold: number, ingesting = false): FieldTone {
  // 取り込み中で、AI が埋めるはずの欄がまだ空 → 回している最中。
  if (ingesting && field.filledBy === null && field.by === "ai") return "loading";

  if (field.filledBy === "ai") {
    if (field.corrected) return "ai-corrected";
    if (field.confidence !== null && field.confidence < confidenceThreshold) {
      return "ai-low-confidence";
    }
    return "ai";
  }
  if (field.filledBy === "human") return "human";
  // filledBy === null = まだ誰も入れていない = 人が埋める欄。
  return "empty";
}

/** 画面での見た目。shared/ui/styles.css のトークンだけを使う。 */
export const TONE_CLASS: Record<FieldTone, string> = {
  ai: "bg-brand/12 border-brand/40",
  // ⚠ 取り込み中。**値が入る前の欄**なので、AI の欄と同じ地に薄く敷いて待たせる。
  loading: "bg-brand/5 border-dashed border-brand/30",
  "ai-low-confidence": "bg-danger/12 border-danger/50",
  // ⚠ 「AI が入力」との差が見て分かる必要がある (人が直した欄だと分かる印)。
  "ai-corrected": "bg-brand/12 border-brand/40 ring-2 ring-inset ring-ink-muted",
  human: "bg-surface border-border",
  empty: "bg-surface border-dashed border-border",
};

export const TONE_LABEL: Record<FieldTone, string> = {
  ai: "AI が入力",
  loading: "AI が読み取り中",
  "ai-low-confidence": "AI が入力 (確信度が低い)",
  "ai-corrected": "AI が入力 → 人が修正",
  human: "人が入力",
  empty: "未入力",
};

/** 一覧の凡例に出す並び。 */
export const TONE_ORDER: readonly FieldTone[] = [
  "loading",
  "ai",
  "ai-low-confidence",
  "ai-corrected",
  "human",
  "empty",
];
