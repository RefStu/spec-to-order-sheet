import type { SVGProps } from "react";

/**
 * 画面で使うアイコン。**インライン SVG だけ。ライブラリは入れない。**
 *
 * ⚠ 要るのは数個 (アプリ / 案件 / 発注書分類 / ユーザー / 開閉 / 取り消し) で、
 *   そのためにアイコンのパッケージを足すと **Workers のバンドルに載る**。
 *   インライン SVG なら依存ゼロで、使っていないものは tree-shake で落ちる。
 * ⚠ **色を決め打ちしない。** `stroke="currentColor"` にして、置いた場所の文字色に従う。
 * ⚠ 飾りなので `aria-hidden`。意味は隣の文字が持つ。
 */

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** アプリの印。宝飾なので石の形。 */
export function AppIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3h12l3 6-9 12L3 9z" />
      <path d="M3 9h18M9 3 6 9l6 12 6-12-3-6" />
    </Icon>
  );
}

/** 案件 (届いた帳票の束)。 */
export function CasesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2.5h6.5A1.5 1.5 0 0 1 20 8v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
    </Icon>
  );
}

/** 発注書分類 (様式と指示文)。 */
export function FormsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </Icon>
  );
}

/** ユーザー管理。 */
export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
    </Icon>
  );
}

/** サイドバーをたたむ。 */
export function CollapseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 6 8 12l6 6" />
    </Icon>
  );
}

/** サイドバーをひらく。 */
export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m10 6 6 6-6 6" />
    </Icon>
  );
}

/** 取り消し / 削除。 */
export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7" />
      <path d="M6 7v12.5A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  );
}

/** アップロード (上向きの矢印とトレイ)。 */
export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 14.5v4A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-4" />
    </Icon>
  );
}

/** 取り込み中 (回る)。⚠ `motion-reduce` で止める。 */
export function SpinnerIcon(props: IconProps) {
  return (
    <Icon className="animate-spin motion-reduce:animate-none" {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Icon>
  );
}

/**
 * ナビゲーションのアイコン。**feature は文字列のキーだけを申告する**
 * (`client.ts` の `handle.navIcon`)。実体を feature に持たせない。
 */
export const NAV_ICONS = {
  cases: CasesIcon,
  forms: FormsIcon,
  users: UsersIcon,
} as const;

export type NavIconKey = keyof typeof NAV_ICONS;

export function isNavIconKey(value: unknown): value is NavIconKey {
  return typeof value === "string" && value in NAV_ICONS;
}
