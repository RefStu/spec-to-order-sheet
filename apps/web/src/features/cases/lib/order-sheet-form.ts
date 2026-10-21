/**
 * ★★ ORDER SHEET の**紙の形**を画面側に写したもの。
 *
 * ⚠⚠ **正は `features/order-sheets/lib/order-sheet-layout.ts`。**
 *   ESLint の boundaries が feature 間の import を `import type` でも禁止しているので
 *   読めない (`order-sheet-contract.ts` と同じ事情)。**写して、テストで突き合わせる。**
 * ⚠ ここに「AI の欄 / 人の欄」を書かない。**位置と形だけ。**
 *   どの欄が AI かは API が返す `by` で決まる。
 * ⚠⚠ **セルの鍵そのものが xlsx の番地。**画面と xlsx の住所が
 *   1 対 1 になったので、「鍵」と「番地」を別々に持つ必要が無くなった。**値は持たない。**
 * ⚠⚠ **画面は紙の格子ではなく、区画と入力欄の GUI**（組み立ては `order-sheet-sections.ts`）。
 *   そのため、このファイルは**番地を作るのに要るものと、見出しの文字だけ**を持つ。
 *   ⚠ 紙の格子のための写し（結合・列幅・行の高さ）は持たない。理由は末尾のコメント。
 */

/**
 * 明細 1 件が占める行数。**実物がこの形。**
 *
 * ⚠ 枠の 3〜6 行目には、実物では原型No (Code Master の下) と POLISH・メッキ・ロゴ
 *   (Description の下) が入る。**それぞれが独立したセル**で、鍵は `"D17"` / `"F17"` …。
 */
export const BLOCK_ROWS = 6;

/**
 * 値が入る行 (枠の先頭から数えて 0 始まり)。
 *
 * ⚠⚠ **枠の 2 行目。1 行目は空。** **実物を実測して**決めた
 *   (`order-sheet-layout.ts` の `VALUE_ROW` と同じ値。根拠もそちらに書いてある)。
 *   実物の罫線は 行 15 に上辺・行 20 に下辺で、値は行 16 に入っている。
 *   ⚠ **`0` に戻さないこと。** 実物の紙で確かめた値。
 */
export const VALUE_ROW = 1;

/** 明細の枠が始まる行 (xlsx の行番号)。写し。⚠ 値が入るのはその 1 つ下 (行 16)。 */
export const FIRST_BLOCK_ROW = 15;

/** 明細の枠の数。**これを超える明細は出せない**(API が 422 で断る)。写し。 */
export const BLOCK_COUNT = 12;

/**
 * ★★ 枠の数。**明細の数だけ**（0 件でも 1 個）。写し（正は `order-sheet-layout.ts` の `blockCountOf()`）。
 *
 * ⚠⚠ 枠の数と合計の行は明細の数で動く（いつも 12 個・`I88` ではない）。
 *   実物と同じく、明細 2 件なら 枠 2 個 → 空き行 27 → 合計 28。
 * ⚠ 正のほうは上限を超えると例外を投げるが、画面は**落とさない**（超えた明細は xlsx の出口が
 *   422 で断る）。ここは上限で止めるだけ。
 */
export function blockCountOf(lineCount: number): number {
  return Math.min(BLOCK_COUNT, Math.max(1, Math.trunc(lineCount)));
}

/**
 * ★★ 合計の行（`I<行>` / `J<行>`）。写し（正は `totalRowOf()`）。
 * ⚠ 枠の直後ではなく**空き行を 1 本はさむ** (実物が 26→27→28)。
 */
export function totalRowOf(lineCount: number): number {
  return FIRST_BLOCK_ROW + BLOCK_ROWS * blockCountOf(lineCount) + 1;
}

/**
 * ★ 紙の列 (A..L)。
 *
 * ⚠⚠ **`CELL_COLUMNS` と別物。** あちらは明細のセルに使える 10 列で、
 *   A (連番) と E (写真) が入っていない。**この違いが「打てるセル」の規則そのもの。**
 * ⚠ 画面はこの 12 列を順に描かない。
 *   残してあるのは**実物の列の並びを固定する**ため (`order-sheet-form.test.ts` が
 *   `A14:L14` の見出しをこの順で突き合わせる)。
 */
export const SHEET_COLUMNS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"] as const;

/** 明細のセルに使える列。写し。⚠ A (連番) と E (写真) は入らない。 */
export const CELL_COLUMNS = ["B", "C", "D", "F", "G", "H", "I", "J", "K", "L"] as const;

/**
 * ★★ 帳票に**印字されている見出し**（番地 → 文字）。正は `SHEET_HEADINGS`。
 *
 * ⚠⚠ **正のほうは末尾の空白まで持っている**（`"ORDER SHEET  "` / `"SHIP DATE "`）。
 *   xlsx を実物と 1 文字も違わず再現するため。**画面は `.trim()` した形**で持つ。
 * ⚠ 見出しは**欄ではない**。打たせないことの判定材料でもある。
 */
export const SHEET_HEADINGS: Readonly<Record<string, string>> = {
  // 帳票の題
  B2: "PRODUCTION PLAN",
  F2: "ORDER SHEET",
  // 工程表の見出しと工程名
  A3: "No.",
  B3: "Process",
  C3: "Start",
  D3: "Stop",
  E3: "Day",
  B4: "WAX",
  B5: "CASTING",
  B6: "FILLING",
  B7: "SETTING",
  B8: "POLISHING",
  B9: "PLATING",
  B10: "FINAL QC+REPAIR",
  // ヘッダ側の単位（`G7` の合計に添える）
  H7: "PCS",
  // 明細の見出し
  A14: "No.",
  B14: "Code",
  C14: "ID",
  D14: "Code Master",
  E14: "Picture",
  F14: "Description",
  G14: "STONE",
  H14: "Size",
  I14: "QTY",
  J14: "Unit",
  K14: "SHIP DATE",
  L14: "REMARK",
};

/**
 * 合計の行に添える単位（実物の `J28` = `PCS`）。
 * ⚠ 番地は明細の数で動く（`J${totalRowOf(n)}`）ので、`SHEET_HEADINGS` には入れない。
 */
export const TOTAL_UNIT_TEXT = "PCS";

/**
 * ★ 工程表の人が打つセル (`C4:E10`)。**ここも欄。**
 *
 * ⚠ 値は**文字のまま**扱う（日付に寄せない）。理由は正のファイルの `PLAN_CELLS`。
 */
export const PLAN_CELLS: readonly string[] = [
  "C4",
  "D4",
  "E4",
  "C5",
  "D5",
  "E5",
  "C6",
  "D6",
  "E6",
  "C7",
  "D7",
  "E7",
  "C8",
  "D8",
  "E8",
  "C9",
  "D9",
  "E9",
  "C10",
  "D10",
  "E10",
];

/**
 * ★ 雛形の**数式**が入るセル (`G7` と `I<合計>`。明細 2 件なら `I28`)。写し。
 *
 * ⚠⚠ **画面は数字を出すが打たせない。** xlsx 側は数式のまま
 *   （値で上書きすると、人が Excel で明細を直したときに合計が追従しなくなる）。
 */
export function computedCellsOf(lineCount: number): string[] {
  return ["G7", `I${totalRowOf(lineCount)}`];
}

/** 人が打てるヘッダのセル。⚠ 派生 (`A12` / `J12` / `F5`) は入らない。 */
export const HEADER_VALUE_CELLS: readonly string[] = ["J5", "J7", "D12", "F12", ...PLAN_CELLS];

/** 値は出るが**打てない**セル。`A12` と `J12` は契約にあり、`F5` は `A12` から出す。 */
export const DERIVED_HEADER_CELLS: readonly string[] = ["A12", "J12", "F5"];

/**
 * ★★ ヘッダの**印字の接頭辞**（番地 → 文字）。写し（正は `order-sheet-layout.ts` の `HEADER_CELLS`）。
 *
 * ⚠⚠ **画面は入力欄の前にこの文字を出す。**xlsx は `SHIP : 1/2/99` のように
 *   接頭辞と値を 1 つのセルに入れるので、出さないと**画面と xlsx で文字が違う**。
 * ⚠ 接頭辞は**値に入れない**（保存するのは打った文字だけ）。xlsx を書くときに
 *   `order-sheets/lib/cell-text.ts` の `headerCellText()` が同じ規則でつなぐ
 *   （値が空なら接頭辞ごと空）。
 * ⚠ 空白の数まで実物どおり（`SHIP : ` と `PO: ` で違う）。**整えないこと。**
 */
export const HEADER_PREFIXES: Readonly<Record<string, string>> = {
  J5: "SHIP : ",
  J7: "Customer PO : ",
  A12: "CUSTOMER: ",
  D12: "PO: ",
  F12: "SO: ",
  J12: "DATE : ",
};

/**
 * ★★ QTY を**数として数えてよいとき**だけ数にする（それ以外は `null`）。
 *   写し（正は `order-sheets/lib/cell-text.ts` の `qtyNumberOf()`）。
 *
 * ⚠⚠ **xlsx はこれが数を返す QTY だけを数値のセルにし、残りは文字のまま入れる。**
 *   Excel の `SUM` は数値のセルしか数えないので、画面の合計もこれで数えないと
 *   `3.0` や `03`（xlsx では文字）が**画面の合計にだけ**入ってずれる。
 * ⚠ 「数値にしても同じ文字に見える」ときだけ数（`3.0` / `1e3` / 全角の `３` は文字）。
 *   11 字を超える数も文字（Excel の標準の表示が `1.23457E+11` のように丸めるため）。
 */
export function qtyNumberOf(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const body = String(text).trim();
  if (body.length === 0 || body.length > 11) return null;
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/u.test(body)) return null;
  const n = Number(body);
  return Number.isFinite(n) && String(n) === body ? n : null;
}

/** その明細の枠が xlsx の何行目から始まるか (1 始まりの明細番号)。 */
export function blockRowOf(lineNo: number): number {
  return FIRST_BLOCK_ROW + (lineNo - 1) * BLOCK_ROWS;
}

/**
 * ★★ 枠のセルの**番地**（`"G16"` / `"F17"`）。**鍵と番地が同じもの**になった。
 *
 * ⚠⚠ **正は `order-sheets/lib/order-sheet-layout.ts` の `lineCellRef()`。** feature をまたいで
 *   import できないので写してある。ずれたら `order-sheet-form.test.ts` が落ちる。
 * ⚠ `lineNo` は **1 始まり**（API が返す明細の番号）。正のほうは 0 始まりの `lineIndex` なので、
 *   突き合わせるテストは `lineNo - 1` で渡すこと。
 * ⚠ **検証はしない。** `"A"` や `"E"` を渡せば `"A16"` を作ってしまう（正のほうは例外を投げる）。
 *   セルを組むときは `isLineCellRef()` で門番すること。
 */
export function cellRefOf(column: string, lineNo: number, rowOffset = 0): string {
  return `${column}${blockRowOf(lineNo) + VALUE_ROW + rowOffset}`;
}

/** 数量のセルの番地（画面で合計を数えるのに使う）。⚠ 明細ごとに違う。 */
export function qtyRefOf(lineNo: number): string {
  return `I${blockRowOf(lineNo) + VALUE_ROW}`;
}

/**
 * ★★ その番地が**明細のセル**か。正は `order-sheet-layout.ts` の `isLineCellRef()`。
 *
 * ⚠⚠ **A 列と E 列は偽。** 連番と写真は文字のセルではないので、`cells` に入れると
 *   API の `cellKeySchema` が弾く。セルを組むループの門番はこれ。
 */
export function isLineCellRef(ref: string): boolean {
  const m = /^([A-L])([1-9][0-9]{0,2})$/u.exec(ref);
  if (!m) return false;
  if (!(CELL_COLUMNS as readonly string[]).includes(m[1]!)) return false;
  const fromFirstBlock = Number(m[2]) - FIRST_BLOCK_ROW;
  if (fromFirstBlock < 0) return false;
  const lineIndex = Math.floor(fromFirstBlock / BLOCK_ROWS);
  return lineIndex < BLOCK_COUNT;
}

/** 値が入っていないセル。画面は枠の全セルを出すので、API に無い鍵はこれで埋める。 */
export const BLANK_CELL = {
  value: null,
  by: "human",
  filledBy: null,
  confidence: null,
  corrected: false,
  source: null,
} as const;

/*
 * ⚠ **紙の格子のための写し（結合・列幅・行の高さ）はここに持たない。** 画面は区画と入力欄の
 *   GUI（`lib/order-sheet-sections.ts`）で、表を描かないため。
 *   ⚠⚠ 正の `order-sheets/lib/order-sheet-layout.ts` は `SHEET_MERGES` なども持っている
 *   （xlsx の生成と雛形のテストが使う）。
 * ⚠ ヘッダの欄の鍵は**番地そのもの**なので、「欄の名前 → 番地」の対応表は持たない
 *   （見出しの日本語は `order-sheet-contract.ts` の `HEADER_FIELD_LABELS`）。
 *   **対応表を作らないこと** — 2 か所になるとずれる。
 * ⚠ 明細の列見出しは `SHEET_HEADINGS` の `A14:L14` から引く。
 */
