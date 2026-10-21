/**
 * ★★ ORDER SHEET の**紙の形**。xlsx の雛形と画面はここから出る。
 *
 * ⚠⚠ **正はこのファイル 1 か所。** 目印 (`{{…}}`) の名前を変えるときは、
 *   雛形 (`order-sheet-template.ts`) の目印も同じ名前に揃えること
 *   (雛形と食い違うと `injectCells` が例外で落ちる — 黙ってずれない)。
 * ⚠ **「誰が埋める欄か」はここに書かない。** それは `order-sheet-fields.ts` の担当
 *   (8 欄 / 6 欄の定義が 2 か所になると必ずずれる)。ここは**位置と形**だけ。
 */

/**
 * 明細 1 件が占める行数 (実物がこの形)。
 *
 * ⚠⚠ **値は枠の 2 行目に入る** (明細 1 件目なら枠 = 行 15..20、値は行 16)。
 *   **実物を実測して**決めた。根拠は 3 つとも紙のほうにある:
 *   ① 元にした実物の xlsx（非公開）の行 15 に `top: thin`、行 20 に `bottom: thin`
 *      (行 21 に top、行 26 に bottom)。**罫線がそう言っている。**
 *   ② 行 15〜26 だけが `ht=45 customHeight`。行 27 は既定の高さで罫線なし
 *      (= 枠と合計の間の空き行)。
 *   ③ `xl/drawings/drawing1.xml` の写真の錨が `col=4 (E)` の `row=14` と `row=20`
 *      (0 始まり = 行 15 と行 21) にある。**各枠の先頭行**に打たれている。
 *   ⚠ **コードを根拠にして 1 行目だと決め直さないこと** (一度やった)。
 *   コードどうしを突き合わせても、紙とずれていたことは分からない。
 * ⚠ 枠の 3〜6 行目には、実物では原型No (Code master の下) と
 *   POLISH・メッキ・ロゴ (Description の下) が入る。
 *   **それぞれが独立したセル**で、`cells_json` の `"D17"` / `"F17"` … が持つ
 *   （⚠ 2 件目なら `"D23"` / `"F23"`）。
 */
export const BLOCK_ROWS = 6;

/** 明細の枠をいくつ用意するか。**これを超える明細は出せない** (422 で断る)。 */
export const BLOCK_COUNT = 12;

/**
 * 枠の中で**値が入る行**(枠の先頭からの差)。
 *
 * ⚠⚠ **枠の 1 行目は空**で、値は 2 行目。`LINE_CELLS` の `rowOffset` は
 *   **この行からの差**で数える (枠の先頭からの差ではない)。
 *   そうしておくと、枠の境目が動いても**目印の名前と絶対番地が変わらない**。
 */
export const VALUE_ROW = 1;

/** 明細の枠が始まる行。⚠ 値が入るのは `FIRST_BLOCK_ROW + VALUE_ROW` = 行 16。 */
export const FIRST_BLOCK_ROW = 15;

/**
 * ★★ 描き出す枠の数。**明細の数だけ**（0 件でも枠は 1 個）。
 *
 * ⚠⚠ **以前は枠はいつも 12 個で、合計はいつも `I88` だった。**
 *   明細 2 件でも空の枠が 10 個並び、合計は 60 行下に離れていた。いまは実物
 *   (元にした実物の xlsx（非公開）= 枠 2 個・空き行 27・合計 `I28`) と同じく、
 *   **枠は明細の数だけ**にする。雛形は 12 枠のまま作り、描き出しで後ろを落とす
 *   (`order-sheet-fit.ts`)。
 * ⚠ 上限を超えたら例外（呼び手は先に `TooManyLines` で 422 にしている。黙って切らない）。
 */
export function blockCountOf(lineCount: number): number {
  if (!Number.isInteger(lineCount) || lineCount < 0 || lineCount > BLOCK_COUNT) {
    throw new Error(`枠に収まらない明細の数です: ${lineCount}`);
  }
  return Math.max(1, lineCount);
}

/**
 * ★★ 合計の行（`I<行>` の `SUM` と `J<行>` の `PCS`）。**正はこの関数 1 つ。**
 *
 * ⚠ **枠の直後ではない。** 実物は 枠の末尾 26 → **空き行 27** → 合計 28 の並び
 *   (`+ 1` がその空き行)。明細 2 件なら 28、12 件なら 88。
 * ⚠⚠ 画面・xlsx・数式の範囲・`computedCellsOf()` はみなここを読む。**行番号を直書きしない。**
 */
export function totalRowOf(lineCount: number): number {
  return FIRST_BLOCK_ROW + BLOCK_ROWS * blockCountOf(lineCount) + 1;
}

/** 最後の枠の末尾の行（合計の `SUM(I15:I<ここ>)` の終わり）。 */
export function lastBlockRowOf(lineCount: number): number {
  return totalRowOf(lineCount) - 2;
}

/**
 * **雛形の**合計の行（枠 12 個 → `88`）。
 *
 * ⚠⚠ **描き出した xlsx の合計の行ではない。** それは `totalRowOf(明細の数)`。
 *   ここを使ってよいのは雛形を作る側 (実物の xlsx から雛形を生成したとき) と、雛形を削る側
 *   (`order-sheet-fit.ts`) だけ。
 */
export const TEMPLATE_TOTAL_ROW = totalRowOf(BLOCK_COUNT);

/**
 * ★ 合計の行の下に、印刷範囲として何行ぶん残すか。
 *
 * 実物は合計 `28` に対して印刷範囲が `$A$1:$L$31`（合計の下の二重線の行 29 と余白）。
 */
export const PRINT_AREA_ROWS_BELOW_TOTAL = 3;

/**
 * ★ 2 ページ目以降にも繰り返して刷る行（実物の `_xlnm.Print_Titles` = `$12:$14`）。
 *   改ページの位置を決めるときに、2 ページ目以降はこの高さぶんが先に埋まる。
 *   ⚠ 雛形の `workbook.xml` と一致することは `order-sheet-template.test.ts` が見る。
 */
export const PRINT_TITLE_ROWS = { first: 12, last: 14 } as const;

/**
 * ★★ 明細の枠の**セルの鍵 = xlsx の絶対番地**（`"F16"` = 行 16 の F 列）。
 *
 * ⚠⚠ **「相対」から「絶対」へ変えた。**
 *   それまでは `"<列>:<値の行からの差>"`（`"F:0"`）で、**枠の境目が動いても鍵が腐らない**のが
 *   利点だった（ `FIRST_BLOCK_ROW` が 16→15 に動いたのに、値の絶対番地
 *   16 / 22 / 28 は動かなかった）。**その利点は捨てた。** 画面・API・xlsx・見出しの
 *   ぜんぶを 1 つの住所の体系に揃えるため。
 *
 * ⚠⚠ **捨てた代わりの歯止め — 幾何を動かすときは必ずデータ migration を書くこと。**
 *   `FIRST_BLOCK_ROW` / `BLOCK_ROWS` / `VALUE_ROW` / `BLOCK_COUNT` のどれかを動かすと、
 *   腐るのは `order_sheet_lines.cells_json` **だけでなく**
 *   `ai_extraction_fields.target_column` と `ai_field_corrections.target_column` の **3 表**。
 *   `CELL_GEOMETRY_VERSION` を上げると `order-sheet-layout.test.ts` が落ちるので、
 *   **そこが migration を書く合図**になる。
 * ⚠ 列に **A（連番）と E（写真）は入れない。** A は画面が出す連番、E は文字ではなく画像
 *   （`order_sheet_line_photos` と R2 に実体がある）。
 */
export const CELL_COLUMNS = ["B", "C", "D", "F", "G", "H", "I", "J", "K", "L"] as const;
export type CellColumn = (typeof CELL_COLUMNS)[number];

/**
 * ★★ 枠の幾何の版。**上の 4 つの定数を動かしたら上げること。**
 *
 * ⚠⚠ 上げると `order-sheet-layout.test.ts` が落ちる。**それが正しい挙動**で、
 *   「保存済みの番地を書き換える migration を書いたか」を人に思い出させるためにある。
 */
export const CELL_GEOMETRY_VERSION = 1;

/** セルの差の下限（枠の 1 行目）。⚠ 実物ではここは空。 */
export const MIN_CELL_OFFSET = -VALUE_ROW;
/** セルの差の上限（枠の最終行）。 */
export const MAX_CELL_OFFSET = BLOCK_ROWS - 1 - VALUE_ROW;

/**
 * 明細のセルの番地を作る（`("F", 0, 1)` → `"F17"`）。
 *
 * @param lineIndex 明細の番号（**0 始まり**）。
 * @param rowOffset **値の行からの差**（0 = 値が入る行 = 枠の 2 行目）。
 * ⚠ 範囲外なら例外（黙ってずれない）。
 */
export function lineCellRef(column: string, lineIndex: number, rowOffset = 0): string {
  if (!isCellColumn(column)) throw new Error(`セルに使えない列です: ${column}`);
  if (!isCellOffset(rowOffset)) throw new Error(`枠の外の行です: ${rowOffset}`);
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= BLOCK_COUNT) {
    throw new Error(`枠の外の明細です: ${lineIndex}`);
  }
  return `${column}${FIRST_BLOCK_ROW + lineIndex * BLOCK_ROWS + VALUE_ROW + rowOffset}`;
}

/** 番地を列と行に割る。**形が違えば null**。⚠ 枠の中かどうかは見ない。 */
export function parseCellRef(ref: string): { column: string; row: number } | null {
  const matched = /^([A-L])([1-9][0-9]{0,2})$/u.exec(ref);
  if (!matched) return null;
  return { column: matched[1]!, row: Number(matched[2]) };
}

/**
 * 明細のセルの番地を読む（`"F17"` → `{ column: "F", lineIndex: 0, rowOffset: 1 }`）。
 * **枠の外・使えない列なら null**（呼び手が弾く）。
 */
export function parseLineCellRef(
  ref: string,
): { column: CellColumn; lineIndex: number; rowOffset: number } | null {
  const parsed = parseCellRef(ref);
  if (!parsed || !isCellColumn(parsed.column)) return null;
  /*
   * ⚠⚠ **枠の先頭からの差で割ること。** 値の行からの差 (`row - FIRST - VALUE_ROW`) で
   *   割ると、枠の 1 行目 (`B15` = 差 -1) が `Math.floor(-1/6) = -1` になって
   *   **1 件目のセルが「枠の外」と判定される**（実際に起きた）。
   */
  const fromFirstBlock = parsed.row - FIRST_BLOCK_ROW;
  const lineIndex = Math.floor(fromFirstBlock / BLOCK_ROWS);
  const rowOffset = fromFirstBlock - lineIndex * BLOCK_ROWS - VALUE_ROW;
  if (lineIndex < 0 || lineIndex >= BLOCK_COUNT) return null;
  if (!isCellOffset(rowOffset)) return null;
  return { column: parsed.column, lineIndex, rowOffset };
}

/**
 * ★★ 使える明細のセルの番地**全部**（10 列 × 6 行 × 12 枠 = 720）。
 *
 * ⚠⚠ **一覧は幾何から作る。** 正規表現で判定すると、`FIRST_BLOCK_ROW` を動かしたときに
 *   **検証器だけが取り残される**（鍵は腐っているのに通ってしまう）。
 */
const LINE_CELL_REFS: ReadonlySet<string> = new Set(
  Array.from({ length: BLOCK_COUNT }, (_unused, lineIndex) =>
    CELL_COLUMNS.flatMap((column) =>
      Array.from({ length: BLOCK_ROWS }, (_u, i) =>
        lineCellRef(column, lineIndex, MIN_CELL_OFFSET + i),
      ),
    ),
  ).flat(),
);

/** その番地が**明細のセル**か。⚠ 見出しとヘッダの番地はここでは偽になる。 */
export function isLineCellRef(ref: string): boolean {
  return LINE_CELL_REFS.has(ref);
}

/** 明細 1 件ぶんの番地を全部並べる（画面の格子に使う）。 */
export function lineCellRefs(lineIndex: number): string[] {
  const refs: string[] = [];
  for (let offset = MIN_CELL_OFFSET; offset <= MAX_CELL_OFFSET; offset++) {
    for (const column of CELL_COLUMNS) refs.push(lineCellRef(column, lineIndex, offset));
  }
  return refs;
}

/** 使える番地を全部並べる（雛形の検査とテストに使う）。 */
export function allLineCellRefs(): string[] {
  return [...LINE_CELL_REFS];
}

function isCellColumn(column: string): column is CellColumn {
  return (CELL_COLUMNS as readonly string[]).includes(column);
}

function isCellOffset(rowOffset: number): boolean {
  return (
    Number.isInteger(rowOffset) && rowOffset >= MIN_CELL_OFFSET && rowOffset <= MAX_CELL_OFFSET
  );
}

/**
 * 明細 1 件ぶんの目印 (`_1` … `_12` が付く)。
 *
 * ⚠ **Picture の目印は無い。** 絵はセルの値ではなく**浮いた図形**なので、
 *   `lib/xlsx-drawing.ts` が錨 (`PICTURE_ANCHOR`) で置く。
 */
export const LINE_TOKENS = {
  no: "NO",
  code: "CODE",
  internalId: "ID",
  codeMaster: "CODE_MASTER",
  description: "DESC",
  stone: "STONE",
  size: "SIZE",
  qty: "QTY",
  unit: "UNIT",
  shipDate: "SHIP_DATE",
  remark: "REMARK",
} as const;

export type LineTokenKey = keyof typeof LINE_TOKENS;

/**
 * 折り返して表示する列。
 *
 * ⚠ 実物の D 列 (Code master) と F 列 (Description) は 1 セルの字が長い。
 *   ⚠⚠ **以前は「改行 1 つが枠の 1 行」という仕掛けがあった**（1 つの textarea に
 *   複数セルぶんを詰めていた）。いまは**セル 1 つ = 値 1 つ**なので、折り返しは
 *   見た目のためだけ。
 */
export const WRAP_TEXT_COLUMNS: readonly string[] = ["D", "F"];

/**
 * `QTY_3` のような目印の名前を作る。**1 始まり。**
 *
 * @param rowOffset **値の行からの差** (0 = 値が入る行 = 枠の 2 行目)。
 *   0 以外なら `DESC_R2_3` のように**何本目の継ぎ行か**が入る。
 *   ⚠ 枠の先頭からの差ではないので、枠の境目が動いても名前は変わらない。
 */
export function lineToken(key: LineTokenKey, blockIndex: number, rowOffset = 0): string {
  const row = rowOffset === 0 ? "" : `_R${rowOffset + 1}`;
  return `${LINE_TOKENS[key]}${row}_${blockIndex + 1}`;
}

/**
 * 明細の枠の中で、どのセルにどの目印を置くか。
 *
 * ⚠⚠ **目印を置くのは値の行 (`rowOffset` = 0 = 行 16) だけ。**
 *   ⚠ **継ぎ行には目印を置かない。** 1 明細あたり 50 セル × 12 = 600 個になって雛形が太る。
 *   継ぎ行は `xlsx-inject.ts` の `injectCellsByRef()` が**番地で直接**埋める
 *   (雛形の空セルに入れるので、罫線と折り返しの書式はそのまま残る)。
 * ⚠ ここは「どのセルがどの型か」を持つ表でもある (数に読める QTY だけが数値。
 *   SHIP DATE は **文字のまま** — `order-sheet-xlsx.ts` の `valueOfCell()`)。
 */
export const LINE_CELLS: { key: LineTokenKey; column: string; rowOffset: number }[] = [
  { key: "no", column: "A", rowOffset: 0 },
  { key: "code", column: "B", rowOffset: 0 },
  { key: "internalId", column: "C", rowOffset: 0 },
  { key: "codeMaster", column: "D", rowOffset: 0 },
  { key: "description", column: "F", rowOffset: 0 },
  { key: "stone", column: "G", rowOffset: 0 },
  { key: "size", column: "H", rowOffset: 0 },
  { key: "qty", column: "I", rowOffset: 0 },
  { key: "unit", column: "J", rowOffset: 0 },
  { key: "shipDate", column: "K", rowOffset: 0 },
  { key: "remark", column: "L", rowOffset: 0 },
];

/**
 * ★★ Picture（E 列）の**絵を置く錨**。⚠ セルではない — 文字ではなく図形なので。
 *
 * 実物の `xl/drawings/drawing1.xml` は `oneCellAnchor` を **`col=4`(E 列) の
 * `row=14` と `row=20`**（0 始まり = 行 15 と行 21）に打っている。
 * **= 各枠の先頭行**に錨を打ち、`<xdr:ext>` の大きさで枠の 6 行ぶんにまたがせている。
 * ここも同じにする。
 *
 * ⚠ 箱の大きさは EMU（English Metric Unit）。1 px = 9525、1 pt = 12700。
 *   E 列は 69 字 ≒ 488px、枠は 45pt × 6 行。
 */
export const PICTURE_ANCHOR = {
  /** E 列（0 始まり）。 */
  col: 4,
  /** 枠の先頭行（`rowOffset` は値の行からの差なので、枠の先頭は `-VALUE_ROW`）。 */
  rowOffset: -VALUE_ROW,
  /** 収める箱の横幅（EMU）。 */
  boxWidthEmu: 488 * 9525,
  /** 収める箱の高さ（EMU）。 */
  boxHeightEmu: 45 * BLOCK_ROWS * 12700,
} as const;

/** 明細 `lineIndex`（0 始まり）の錨を打つ行（**0 始まり**。drawing の座標はそう数える）。 */
export function pictureAnchorRow(lineIndex: number): number {
  return FIRST_BLOCK_ROW - 1 + lineIndex * BLOCK_ROWS + VALUE_ROW + PICTURE_ANCHOR.rowOffset;
}

/**
 * 明細の SHIP DATE の**表示形式**（実物の xlsx から雛形を生成したときに使った）。
 *
 * ⚠⚠ **SHIP DATE は文字のまま xlsx に入る**（シリアル値にしない）。
 *   この表示形式は数値のセルにしか効かないので、**いまは実質どこにも効いていない**
 *   （文字のセルは打った文字がそのまま見える）。雛形を作り直さずに済むよう残してある。
 *   それまでは `excelSerial()` でシリアル値にし、`2099/2/1 0:00:00` と見せていた
 *   （画面の文字と違ううえ、`YYYY-MM-DD` で始まらない文字は xlsx でだけ消えていた）。
 * ⚠ 実物の雛形は `d/m/yy`（例: `1/2/99`）。画面の記入例はそちらに寄せた。
 */
export const SHIP_DATE_NUMBER_FORMAT = "yyyy/m/d h:mm:ss";

/**
 * 工程表 (PRODUCTION PLAN) の日付が入る範囲。
 *
 * ⚠⚠ **雛形では空にする。** 実物の日付はシリアル値 (数値セル) なので、
 *   文字の検査をすり抜けて**サンプルの日程がそのまま残る**。**ここは変えない。**
 * ⚠⚠ **「人が打つセル」にしてある。** 人が自由な文字を打つ形なので、
 *   英語の工程名と日本語の工程名の対応を決めなくてよい。
 *   ⚠ 工程の名前 (WAX / CASTING …) は帳票の見出しなので `SHEET_HEADINGS` の担当のまま。
 */
export const PLAN_VALUE_CELLS = {
  // ⚠ 3 行目は見出し (Start / Stop / Day)。消さない。
  firstRow: 4,
  lastRow: 10,
  columns: ["C", "D", "E"],
} as const;

/**
 * ★★ 工程表の人が打つセル (`C4:E10` の 21 個)。⚠ 並びは行ごと (`C4,D4,E4,C5,…`)。
 *
 * ⚠⚠ **リテラルのタプルで持つこと。** `PLAN_VALUE_CELLS` から `map()` で組み立てると
 *   型が `string[]` に落ち、`schema.ts` の `z.enum()` が閉じた集合でなくなる。
 *   ずれは `order-sheet-layout.test.ts` が `PLAN_VALUE_CELLS` との突き合わせで検出する。
 * ⚠⚠ **値は文字のまま**扱う。**`excelSerial()` に通さない。** 雛形の書式は
 *   `numFmt 165 = "dd/mm/yy;@"` で、`;@` の節があるので**打った文字がそのまま出る**。
 *   日付に寄せると、人が書いた自由な文字 (「10月上旬」など) を黙って日付と解釈してしまう。
 */
export const PLAN_CELLS = [
  "C4", "D4", "E4",
  "C5", "D5", "E5",
  "C6", "D6", "E6",
  "C7", "D7", "E7",
  "C8", "D8", "E8",
  "C9", "D9", "E9",
  "C10", "D10", "E10",
] as const;

/**
 * ★★ 紙の列 (A..L の 12 列)。
 *
 * ⚠⚠ **`CELL_COLUMNS` と別物。** あちらは**明細のセルに使える 10 列**で、A (連番) と
 *   E (写真) が入っていない。こちらは**紙にある列そのもの**で、画面の格子が使う。
 *   この違いが「どのセルが打てるか」の規則そのものなので、片方に寄せないこと。
 */
export const SHEET_COLUMNS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L",
] as const;

/**
 * ★★ 結合セル。**実物の `<mergeCells count="7">` の正。**
 *
 * ⚠⚠ **画面に直書きしない。** 以前ははコードが 1 つも持っておらず、
 *   `order-sheet-template.test.ts` が**数だけ**を見ていた (どれかが動いても気づけない)。
 *   いまは同テストが雛形の `<mergeCells>` とこの表を突き合わせる。
 * ⚠ 結合はぜんぶ**行 2〜8** にある。行 12 以降 (明細と合計) には 1 つも無いので、
 *   明細の格子は素直な長方形のまま。
 * ⚠ 写真 (E 列の 6 行ぶん) は**ここに入れない**。あれは紙の結合ではなく
 *   浮いた図形の錨なので、画面側が `PICTURE_ANCHOR` から組み立てる。
 */
export const SHEET_MERGES: readonly string[] = [
  "B2:E2", // PRODUCTION PLAN
  "F2:G4", // ORDER SHEET
  "F5:G6", // 取引先名
  "G7:G8", // 合計本数
  "H7:H8", // PCS
  "J5:L6", // SHIP
  "J7:L8", // Customer PO
];

/**
 * ★ 雛形の**数式**が入るセル (`G7` = `SUM(I<合計>)` と `I<合計>` = `SUM(I15:I<最後の枠の末尾>)`)。
 *   明細 2 件なら `["G7", "I28"]`、12 件なら `["G7", "I88"]`。
 *
 * ⚠⚠ **数式を値で置き換えない。** 画面は同じ数字を出すが、それは
 *   「Excel を開かなくても見える」ためだけのもの。**数式を値で上書きすると、
 *   人が xlsx で明細を直したときに合計が追従しなくなる。**
 * ⚠ ただし 数式の**キャッシュ値 `<v>`** には同じ数を入れる
 *   (`order-sheet-fit.ts`)。再計算しないビューア（プレビュー・一部のスマホのアプリ）で
 *   空に見えないため。数式は残るので、Excel で直せば追従する。
 * ⚠ `order_sheets.total_quantity` には書かない (列はあるが書き手は居ない)。
 */
export function computedCellsOf(lineCount: number): string[] {
  return ["G7", `I${totalRowOf(lineCount)}`];
}

/** ヘッダの欄の値がどこから来るか。 */
export type HeaderCellSource = "cell" | "partner" | "issuedOn";

/**
 * ★★ ヘッダの欄。**鍵は xlsx の番地そのもの。**
 *
 * ⚠ 実物では**接頭辞付きの文字列**が結合セルに入っている（`CUSTOMER: …` など）ので、
 *   接頭辞ごと 1 つの文字列として組み立てる。
 * ⚠⚠ **目印（`{{…}}`）はもう使わない。** ヘッダも見出しも派生も、
 *   ぜんぶ `injectCellsByRef` が**番地で**入れる。目印が残るのは**明細の値の行だけ**。
 *
 * `source` の意味:
 *   - `cell` … 人が画面で打つ。`order_sheets.cells_json` に**番地のまま**入る
 *   - `partner` … `order_sheets.partner_id` から出す**読み取り専用**の派生
 *     （⚠ 取引先はマスタへの外部キーなので、名前を写して持たない）
 *   - `issuedOn` … xlsx を出した日から出す**読み取り専用**の派生
 */
export const HEADER_CELLS: readonly {
  cell: string;
  prefix: string;
  source: HeaderCellSource;
}[] = [
  { cell: "J5", prefix: "SHIP : ", source: "cell" },
  { cell: "J7", prefix: "Customer PO : ", source: "cell" },
  { cell: "A12", prefix: "CUSTOMER: ", source: "partner" },
  { cell: "D12", prefix: "PO: ", source: "cell" },
  { cell: "F12", prefix: "SO: ", source: "cell" },
  { cell: "J12", prefix: "DATE : ", source: "issuedOn" },
  /**
   * ⚠ 取引先名（大きい字）。**見出しではない** — 中身は `partners.name`。
   *   接頭辞は付かない。⚠ 雛形では**空**（実物の取引先名は雛形を作るときに消してある）。
   */
  { cell: "F5", prefix: "", source: "partner" },
  /**
   * ★★ 工程表の日付・日数（`C4:E10`）。**人が打つセルにした。**
   *
   * ⚠ 接頭辞は**付かない**（ヘッダの 6 つと違い、印字に続けて書く欄ではない）。
   * ⚠⚠ ここに並べるだけで `EDITABLE_HEADER_CELLS` / `isHeaderCellRef()` /
   *   `order-sheet-writer.ts` / `parseHeaderCells()` / `buildCellRefs()` が
   *   **全部ついてくる**（どれも `HEADER_CELLS` からの導出になっている）。
   *   ⚠ 唯一ついてこないのが `order-sheet-xlsx.ts` の `toXlsxInput()` で、
   *   あそこは番地をべた書きしていた。**導出に直してある。戻さないこと** —
   *   戻すと値は保存されるのに **xlsx にだけ出ない**（例外も出ない）。
   */
  ...PLAN_CELLS.map((cell) => ({ cell, prefix: "", source: "cell" as const })),
];

/**
 * ★★ 人が画面で打てるヘッダのセルの**リテラルのタプル**。
 *
 * ⚠⚠ **`EDITABLE_HEADER_CELLS` と中身は同じだが、型が違う。** あちらは `HEADER_CELLS` からの
 *   導出なので `string[]` に落ちる。`schema.ts` の `z.enum()` は**リテラルのタプル**を
 *   要求するので、契約にはこちらを使う。
 * ⚠ 2 つが食い違わないことは `order-sheet-layout.test.ts` が固定する
 *   （**3 か所目を作らないための歯止め**）。
 */
export const HEADER_VALUE_CELLS = ["J5", "J7", "D12", "F12", ...PLAN_CELLS] as const;

/** 人が画面で打てるヘッダのセル（`order_sheets.cells_json` に入るのはこれだけ）。 */
export const EDITABLE_HEADER_CELLS: readonly string[] = HEADER_CELLS.filter(
  (header) => header.source === "cell",
).map((header) => header.cell);

/** その番地が**人が打てるヘッダのセル**か。⚠ 派生（A12 / J12 / F5）は偽。 */
export function isHeaderCellRef(ref: string): boolean {
  return EDITABLE_HEADER_CELLS.includes(ref);
}

/** 番地からヘッダの欄の定義を引く。 */
export function headerCellOf(ref: string): (typeof HEADER_CELLS)[number] | undefined {
  return HEADER_CELLS.find((header) => header.cell === ref);
}

/**
 * ★★ 帳票に**印字されている見出し**。番地 → 文字。**ここが正**（雛形ではない）。
 *
 * ⚠⚠ **雛形からコードへ移した。** それまでは雛形の中に印字が残っていて、
 *   `TEMPLATE_ALLOWED_TEXT` という**番地を持たない許可表**が正を名乗っていた。
 *   いまは雛形に印字が 1 つも残らず、`order-sheet-template.test.ts` の
 *   「残っている文字は目印だけ」がそれを**機械で保証する**（＝ 見出しは全部ここにある、の証明）。
 * ⚠ **末尾の空白を整えないこと。** 実物の `F2` は `"ORDER SHEET  "`（空白 2 つ）、
 *   `K14` は `"SHIP DATE "`（空白 1 つ）。**xlsx を実物と 1 文字も違わずに再現する**のが狙い。
 *   画面に出すときは呼ぶ側が `.trim()` する。
 * ⚠ ここに**入れないもの**:
 *   - `A4:A10`（工程の連番 1〜7）… **数値セル**なので文字の仕組みに乗らない。雛形の数値のまま
 *   - `G7`（合計）… 雛形の数式 `SUM(I<合計>)`。行番号は描き出しで `order-sheet-fit.ts` が書き換える
 *   - `J<合計>`（合計の行の `PCS`）… 行が明細の数で動くので `totalHeadingsOf()` の担当
 *   - `C4:E10`（工程表の日付・日数）… **印字ではなく人が打つ値**。`HEADER_CELLS` の担当
 *     （。雛形を空にするのは `PLAN_VALUE_CELLS` のままで正しい）
 *   - `F5`（取引先名）… 印字ではなく `partners.name` の値。`HEADER_CELLS` の担当
 */
export const SHEET_HEADINGS: readonly { cell: string; text: string }[] = [
  // 帳票の題
  { cell: "B2", text: "PRODUCTION PLAN" },
  { cell: "F2", text: "ORDER SHEET  " },
  // 工程表の見出しと工程名
  { cell: "A3", text: "No." },
  { cell: "B3", text: "Process" },
  { cell: "C3", text: "Start" },
  { cell: "D3", text: "Stop" },
  { cell: "E3", text: "Day" },
  { cell: "B4", text: "WAX" },
  { cell: "B5", text: "CASTING" },
  { cell: "B6", text: "FILLING" },
  { cell: "B7", text: "SETTING" },
  { cell: "B8", text: "POLISHING" },
  { cell: "B9", text: "PLATING" },
  { cell: "B10", text: "FINAL QC+REPAIR" },
  // ヘッダ側の単位（合計本数に添える）
  { cell: "H7", text: "PCS" },
  // 明細の見出し
  { cell: "A14", text: "No." },
  { cell: "B14", text: "Code" },
  { cell: "C14", text: "ID" },
  { cell: "D14", text: "Code Master" },
  { cell: "E14", text: "Picture" },
  { cell: "F14", text: "Description" },
  { cell: "G14", text: "STONE" },
  { cell: "H14", text: "Size" },
  { cell: "I14", text: "QTY" },
  { cell: "J14", text: "Unit" },
  { cell: "K14", text: "SHIP DATE " },
  { cell: "L14", text: "REMARK" },
];

/** 合計の行に添える単位の文字（実物の `J28` = `PCS`）。 */
export const TOTAL_UNIT_TEXT = "PCS";

/**
 * ★★ 合計の行の見出し（`J<合計>` の `PCS`）。**行が明細の数で動く**ので、
 *   `SHEET_HEADINGS`（番地の決まった印字）とは分けてある。
 *
 * ⚠⚠ **番地は `totalRowOf()` から作る。** 直書きすると枠の数が変わったときに
 *   **合計の行だけ取り残される**（以前は `J88` 固定だった）。
 * ⚠ 合計そのもの（`I<合計>`）は数式なので、ここには入れない（`computedCellsOf()`）。
 */
export function totalHeadingsOf(lineCount: number): { cell: string; text: string }[] {
  return [{ cell: `J${totalRowOf(lineCount)}`, text: TOTAL_UNIT_TEXT }];
}

/** その明細の数で xlsx に出す見出し**全部**（番地の決まった印字 ＋ 合計の行）。 */
export function sheetHeadingsOf(lineCount: number): { cell: string; text: string }[] {
  return [...SHEET_HEADINGS, ...totalHeadingsOf(lineCount)];
}

/** 明細の見出し（`A14:L14`）を列の記号で引く。画面の列見出しはこれを写す。 */
export function lineHeadingOf(column: string): string | undefined {
  return SHEET_HEADINGS.find((heading) => heading.cell === `${column}14`)?.text;
}
