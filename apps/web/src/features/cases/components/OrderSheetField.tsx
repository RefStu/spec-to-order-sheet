import type { ReactNode } from "react";
import { cn } from "../../../shared/ui/cn";
import { SpinnerIcon } from "../../../shared/ui/icons";
import { fieldTone, TONE_CLASS, TONE_LABEL } from "../lib/field-style";
import type { Field, FieldValue } from "../lib/order-sheet-contract";

/**
 * ★★ ORDER SHEET の欄 1 つ。**塗り分けで AI の欄と人の欄を見分ける。**
 *
 * ⚠⚠ **この部品は「どの欄か」を塗り分けに使わない。**
 *   渡ってくる Field の filledBy / confidence / corrected と、API が返した閾値だけで決める。
 *   label は見出しを出すためだけのもの。
 * ⚠ AI の欄はカーソルを乗せると確信度と「原本の何ページのどこから来たか」が出る。
 *
 * ⚠ **見出しは欄の上に積む形だけ。** 画面は紙の格子ではなく区画と入力欄の GUI なので、
 *   セルの右上に印をかぶせる形は持たない。
 */
export function OrderSheetField({
  label,
  cellRef,
  field,
  confidenceThreshold,
  ingesting = false,
  editable,
  onChange,
  placeholder,
  prefix,
  className,
  children,
}: {
  label: string;
  /**
   * ★ そのセルの xlsx の番地 (`"F16"`)。**ホバーのときだけ出す。**
   *
   * ⚠⚠ **画面の文字としては出さない。**実物の紙に番地は印字されていない。
   * ⚠⚠ **外側の `title` に付けても見えない。** この `<label>` が広がっていて
   *   内側の `title` が勝つ (外側に付けると番地が出ない)。
   * ⚠ `aria-label` には**入れない**。読み上げで「F16」が欄の名前より先に来てしまう。
   */
  cellRef?: string;
  field: Field;
  confidenceThreshold: number;
  /** その発注がまだ取り込み中か (AI が埋める空欄を回す)。 */
  ingesting?: boolean;
  /** 人が入力できるか。AI の欄も直せる (直したら corrections に載る)。 */
  editable: boolean;
  onChange?: (value: FieldValue) => void;
  /**
   * ★ 記入例。
   *
   * ⚠⚠ **実データを置かない。**実物の xlsx はリポジトリに含めないが、
   *   記入例はソースに書くので git に入る。形だけ似せた架空の値を渡すこと
   *   (一覧は `lib/order-sheet-sections.ts` の `LINE_SLOTS` / `HEADER_PLACEHOLDERS`)。
   * ⚠ 渡さなければ今までどおり「未入力」。
   */
  placeholder?: string;
  /**
   * ★ 紙の印字の接頭辞（`SHIP : ` など）。**値の前に、打てない文字として出す。**
   *
   * ⚠⚠ xlsx は `SHIP : 1/2/99` のように接頭辞と値を 1 つのセルに入れる。出さないと
   *   **画面と xlsx で文字が違う**。⚠ 値には入れない（保存するのは打った文字だけ）。
   */
  prefix?: string;
  className?: string;
  /** 値の代わりに出すもの (写真の欄)。塗り分けはそのまま効く。 */
  children?: ReactNode;
}) {
  const tone = fieldTone(field, confidenceThreshold, ingesting);
  const title = [
    TONE_LABEL[tone],
    field.confidence !== null ? `確信度 ${(field.confidence * 100).toFixed(0)}%` : null,
    field.source ? `原本 ${field.source.page} ページ目` : null,
  ]
    .filter(Boolean)
    .join(" / ");

  /**
   * ⚠ **スピナーは見出しに出さない。** 読み取り中は値の場所に「読み取り中 ⟳」を並べる
   *   (見出しの行で回っていると、どの欄を読んでいるのかが伝わらない)。
   */
  const marks = (
    <>
      {tone === "ai-corrected" ? <span title="人が修正しました">✎</span> : null}
      {tone === "ai-low-confidence" ? <span title="確信度が低いので見てください">⚠</span> : null}
    </>
  );

  return (
    <label
      // ⚠ `min-w-0` が無いと、見出しが長い欄 (CUSTOMER) が grid の列からはみ出して
      //   隣の欄に重なる (狭い画面で実際に起きた)。
      className={cn("flex min-w-0 flex-col gap-1", className)}
      title={[cellRef, label, title].filter(Boolean).join(" / ")}
      aria-label={label}
    >
      <span className="flex items-center gap-1 text-xs font-medium text-ink-muted">
        <span className="truncate">{label}</span>
        {marks}
      </span>

      {/*
        ★ 読み取り中は**入力欄を出さない**。
        ⚠ `<input>` の placeholder にアイコンは入れられないので、文字と印を並べた
          表示にする。ついでに読み取り中の欄を人が触れなくなるので、保存に混ざる事故も減る。
        ⚠⚠ **「どの欄か」で判断していない。** `tone` を決めるのは `field-style.ts` の
          `fieldTone()` (by === "ai" && filledBy === null && ingesting) だけ。
      */}
      {tone === "loading" ? (
        <span
          className={cn(
            "flex min-h-8 w-full items-center gap-1.5 rounded-md border px-2 py-1.5",
            "text-sm text-ink-muted",
            TONE_CLASS[tone],
          )}
        >
          読み取り中
          <SpinnerIcon width={12} height={12} />
        </span>
      ) : children ? (
        // ⚠ 写真の欄。絵 + 送り (‹ 1/3 ›) + ゴミ箱が縦に並ぶので、その高さを取る。
        //   ⚠ `children` の無い欄の高さ (min-h-8) は**変えない**。
        <span
          className={cn(
            "flex w-full items-center justify-center rounded-md border p-1",
            TONE_CLASS[tone],
          )}
        >
          {children}
        </span>
      ) : prefix ? (
        /*
         * ⚠ 接頭辞は枠の中・値の前に置く（「この 1 行がそのまま xlsx のセルの文字」と読めるように）。
         *   `whitespace-pre` で末尾の空白も潰さない（`SHIP : ` の後ろの 1 字）。
         */
        <span
          className={cn(
            "flex min-h-8 w-full items-center rounded-md border px-2 text-sm",
            TONE_CLASS[tone],
          )}
        >
          <span className="whitespace-pre text-ink-muted select-none" aria-hidden="true">
            {prefix}
          </span>
          {editable && onChange ? (
            <input
              value={field.value === null ? "" : String(field.value)}
              placeholder={placeholder ?? "未入力"}
              onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
              className={cn(
                "min-w-0 flex-1 bg-transparent py-1.5 text-ink",
                "placeholder:text-ink-muted/50",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand",
              )}
            />
          ) : (
            <span className={cn("py-1.5", field.value === null ? "text-ink-muted" : "text-ink")}>
              {field.value === null ? "未入力" : String(field.value)}
            </span>
          )}
        </span>
      ) : editable && onChange ? (
        /*
         * ⚠ **セル 1 つ = 入力欄 1 つ。** 以前は Code Master と Description だけが
         *   `<textarea>` で、改行 1 つが枠の 1 行になっていた。いまは枠のセルが
         *   そのまま欄なので、**このアプリに textarea は 1 つも無い**。
         */
        <input
          value={field.value === null ? "" : String(field.value)}
          placeholder={placeholder ?? "未入力"}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          className={cn(
            "w-full rounded-md border px-2 py-1.5 text-sm text-ink",
            /*
             * ⚠⚠ **記入例は薄く。** `text-ink-muted` そのままだと**打ち込んだ値に見える**。
             *   地は白なので、透かして淡くする。
             * ⚠ 値そのもの (`text-ink`) の濃さは変えないこと — 見分けが付かなくなる。
             */
            "placeholder:text-ink-muted/50",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand",
            TONE_CLASS[tone],
          )}
        />
      ) : (
        <span
          className={cn(
            "min-h-8 w-full rounded-md border px-2 py-1.5 text-sm",
            TONE_CLASS[tone],
            field.value === null ? "text-ink-muted" : "text-ink",
          )}
        >
          {field.value === null ? "未入力" : String(field.value)}
        </span>
      )}
    </label>
  );
}
