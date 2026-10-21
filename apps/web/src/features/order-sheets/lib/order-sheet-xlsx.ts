import {
  BLOCK_COUNT,
  HEADER_CELLS,
  HEADER_VALUE_CELLS,
  LINE_CELLS,
  lineCellRef,
  lineToken,
  parseLineCellRef,
  sheetHeadingsOf,
  type LineTokenKey,
} from "./order-sheet-layout";
import { fitSheetToLines, fitWorkbookToLines } from "./order-sheet-fit";
import { ORDER_SHEET_TEMPLATE } from "./order-sheet-template";
import { buildDrawingParts, type DrawingParts, type XlsxPicture } from "./xlsx-drawing";
import { buildZip } from "./xlsx-zip";
import { headerCellText, qtyNumberOf, sheetDateText } from "./cell-text";
import { injectCells, injectCellsByRef, type CellValue } from "./xlsx-inject";
import type { OrderSheet } from "../schema";

/**
 * ★ ORDER SHEET を xlsx にする。
 *
 * ⚠⚠ **値の正は D1。** xlsx は出口の変換だけで、画面はこれを読まない
 *   (塗り分けに要る `filledBy` / 確信度 / 原本のページはセルに載らないため)。
 * ⚠ 実物と同じ形にするため、**雛形に値を差し込む**。組み立て直すと
 *   結合・列幅・印刷設定が再現できず、現場がそのまま使えない。
 */

/** 明細の枠より多い明細は出せない (黙って切り捨てない)。 */
export class TooManyLines extends Error {
  constructor(readonly max: number) {
    super("too_many_lines");
  }
}

/**
 * 明細 1 行ぶんの、xlsx に出す値。
 *
 * ⚠⚠ **セルの地図そのまま**（鍵は `"F16"` のような xlsx の絶対番地）。
 *   以前は欄ごとの項目 (`codeMaster` / `description` …) を並べていたが、
 *   画面と DB がセルの格子になったのでここも素通しになった。
 */
export type { XlsxPicture };

export interface XlsxLine {
  cells: Readonly<Record<string, string>>;
}

function text(value: CellValue): string | null {
  if (value === null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * 値の行のセルを、xlsx に入れる形にする。
 *
 * ⚠⚠ **文字を変えない**。画面に出ている文字がそのまま xlsx に入る。
 *   型を変えてよいのは QTY だけで、それも**数値にしても同じ文字に見えるとき**だけ
 *   （`cell-text.ts` の `qtyNumberOf()`）。そうでない QTY は**文字のまま**入れる
 *   — 以前は `Number()` に通していて、**数として読めない文字は消えていた**。
 *   合計（`I<合計>` の `SUM`）は数値のセルだけを数えるので、数を打てば合計が出る。
 * ⚠⚠ **数量 0 を `null` にしない。** 読めなかった明細は数量 0 で作られるので、
 *   `Number(...) || null` と書くと**その行の QTY が黙って空になる**（実際に起きた形）。
 * ⚠⚠ **SHIP DATE をシリアル値に戻さない。** 以前は `excelSerial()` に通していて、
 *   `YYYY-MM-DD` で始まらない文字（画面の記入例の `2026/9/16` も）は**xlsx でだけ空**になり、
 *   読めた日付も `2099/2/1 0:00:00` と画面と違う文字に見えていた。
 *   そのぶん Excel 上では**日付として並べ替え・引き算ができない**（工程表の `C4:E10` と同じ扱い）。
 */
function valueOfCell(key: LineTokenKey, raw: string | null, lineIndex: number): CellValue {
  if (key === "no") return lineIndex + 1;
  const body = text(raw);
  if (body === null) return null;
  if (key === "qty") return qtyNumberOf(body) ?? body;
  return body;
}

/**
 * ORDER SHEET 1 枚ぶんの**目印**と値。
 *
 * ⚠⚠ **目印が残っているのは明細の値の行だけ**。ヘッダも見出しも
 *   `buildCellRefs()` が**番地で**入れる。目印を残す理由は 1 つ — `valueOfCell()` の
 *   **型の知識**（数に読める QTY は数値のセル）がこの道にしか無いから。
 *   ⚠⚠ **値の行を番地の道へ移すなら、`valueOfCell()` も一緒に移すこと。**
 *   移さずに移すと `text()` が全部文字列にして、**合計 (`I<合計>`) の SUM が 0 になる**
 *   （落ちないので気付けない）。
 *   ⚠ SHIP DATE は 文字のまま（シリアル値にしない）。
 */
export function buildTokenValues(input: {
  lines: readonly XlsxLine[];
}): Record<string, CellValue> {
  if (input.lines.length > BLOCK_COUNT) throw new TooManyLines(BLOCK_COUNT);

  const values: Record<string, CellValue> = {};
  input.lines.forEach((line, index) => {
    for (const spec of LINE_CELLS) {
      // ⚠ `no`(A 列) はセルではない。連番なので値を引かない。
      const raw =
        spec.key === "no"
          ? null
          : (line.cells[lineCellRef(spec.column, index, spec.rowOffset)] ?? null);
      values[lineToken(spec.key, index, spec.rowOffset)] = valueOfCell(spec.key, raw, index);
    }
  });

  return values;
}

/**
 * ★★ **番地で入れるものを全部並べる** — 見出し・ヘッダ・派生・明細の継ぎ行。
 *
 * ⚠ 値の行 (`rowOffset === 0`) は目印が持っているので**ここでは出さない**
 *   （出すと `CellRefCollision` で落ちる）。
 * ⚠⚠ **見出しは `text()` に通さない。** `trim()` すると `F2` の `"ORDER SHEET  "` と
 *   `K14` の `"SHIP DATE "` の**末尾の空白が消えて、実物と 1 文字ずれる**。
 */
export function buildCellRefs(input: {
  /** `A12` と `F5` に出す取引先名（`partners.name`。無ければ空）。 */
  partnerName: CellValue;
  /** `J12` に出す、xlsx を出した日 (YYYY-MM-DD)。 */
  issuedOn: string;
  /** 人が打つヘッダ（鍵は番地。`J5` / `J7` / `D12` / `F12`）。 */
  header: Readonly<Record<string, CellValue>>;
  lines: readonly XlsxLine[];
}): Record<string, CellValue> {
  if (input.lines.length > BLOCK_COUNT) throw new TooManyLines(BLOCK_COUNT);
  const refs: Record<string, CellValue> = {};

  // ① 帳票に印字されている見出し。⚠ 末尾の空白ごと入れる。
  // ⚠ 合計の行の `PCS` は**明細の数で行が動く**（2 件なら `J28`）ので、件数から作る。
  for (const heading of sheetHeadingsOf(input.lines.length)) refs[heading.cell] = heading.text;

  /*
   * ② ヘッダの 6 欄（接頭辞込みの 1 文字列）。⚠ 値が無ければ接頭辞ごと空にする。
   * ⚠ 接頭辞は紙の印字で、画面も入力欄の前に**同じ文字**を出す（`cases` の `HEADER_PREFIXES`）。
   * ⚠ DATE（`J12`）だけは実例の書き方（`d/m/yy`）にする。画面も同じ文字を出す（reader）。
   */
  for (const header of HEADER_CELLS) {
    const raw =
      header.source === "cell"
        ? (input.header[header.cell] ?? null)
        : header.source === "partner"
          ? input.partnerName
          : sheetDateText(input.issuedOn);
    refs[header.cell] = headerCellText(header.prefix, raw);
  }

  // ③ 明細の継ぎ行（原型No・POLISH・メッキ・ロゴ …）。
  input.lines.forEach((line, index) => {
    for (const [ref, raw] of Object.entries(line.cells)) {
      const parsed = parseLineCellRef(ref);
      if (!parsed || parsed.rowOffset === 0) continue;
      // ⚠ 別の枠の番地が紛れていたら入れない（雛形の別の明細を上書きしてしまう）。
      if (parsed.lineIndex !== index) continue;
      refs[ref] = text(raw);
    }
  });

  return refs;
}

/**
 * 画面の契約 (`OrderSheet`) から xlsx に出す値を取り出す。
 *
 * ⚠⚠ **すべての値を `sheet` から取る。** 以前は単位だけは D1 を別に引いていた
 *   (画面の欄が無く、`PCS` の直書きだったため)。いまは `fields.UNIT` が欄なので、
 *   **画面に出ている値と xlsx に出る値が必ず一致する**。引き直しを戻さないこと。
 */
export function toXlsxInput(
  sheet: OrderSheet,
  extras: { issuedOn: string; partnerName?: string | null },
) {
  const header = sheet.header;
  return {
    /** ⚠ `A12` / `F5` は `partner_id` からの派生。契約の `A12` は表示用の文字列。 */
    partnerName: extras.partnerName ?? header.A12?.value ?? null,
    issuedOn: extras.issuedOn,
    /*
     * ⚠ 人が打つヘッダだけを番地のまま渡す（`A12` と `J12` は派生なので入れない）。
     * ⚠ お客様の発注No は `J7`、社内の PO / SO は `D12` / `F12`。別物なので混ぜない。
     *
     * ⚠⚠ **番地を書き並べないこと。** 以前は `J5` / `J7` / `D12` / `F12` の
     *   4 つをべた書きしていた。`buildCellRefs()` のほうは `HEADER_CELLS` を回す汎用なのに、
     *   **その入口がここで閉じていた**ので、工程表（`C4:E10`）を足したときに
     *   「値は `cells_json` に保存され、リロードしても残るのに、**xlsx にだけ出ない**」
     *   という壊れ方をする（例外も警告も出ない）。`order-sheet-render.test.ts` が固定する。
     */
    header: Object.fromEntries(
      HEADER_VALUE_CELLS.map((ref) => [ref, header[ref]?.value ?? null]),
    ) as Record<string, CellValue>,
    /*
     * ⚠ **セルを素通しする。** 画面に出ている値がそのまま xlsx の同じ番地に出る、
     *   というのがこの形の肝（欄ごとの取り出しはもう無い）。
     */
    lines: sheet.lines.map((line) => ({
      cells: Object.fromEntries(
        Object.entries(line.cells).map(([ref, field]) => [
          ref,
          field.value === null ? "" : String(field.value),
        ]),
      ),
    })),
  };
}

/** `toXlsxInput()` が返すもの（= xlsx に出す値の全部）。 */
export type XlsxInput = Parameters<typeof buildCellRefs>[0];

/**
 * ★★ 合計の数（`I<合計>` と `G7` の `<v>` に入れるキャッシュ値）。
 *
 * ⚠⚠ **Excel の `SUM` と同じ数にすること。** `SUM` は数値のセルしか数えないので、
 *   ここも**値の行の QTY のうち数値になったもの**だけを足す（`valueOfCell()` を通した後の値）。
 *   継ぎ行の文字や、数に読めない QTY（文字のまま入る）は `SUM` と同じく数えない。
 * ⚠ 画面の合計（`cases/lib/order-sheet-draft.ts` の `qtyTotalOf()`）も同じ QTY の欄を、
 *   **同じ判定**（`qtyNumberOf()` の写し）で足す。
 */
export function totalQuantityOf(values: Readonly<Record<string, CellValue>>, lineCount: number): number {
  let total = 0;
  for (let index = 0; index < lineCount; index++) {
    const value = values[lineToken("qty", index)];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

/**
 * 雛形に値を差し込んで xlsx のバイト列にする。
 *
 * ⚠⚠ **入力は `toXlsxInput()` の形まるごと。** それまでは
 *   目印の値と番地の値を別々に受け取っていたが、**枠の数（= 明細の数）**が描き出しの形を
 *   決めるようになったので、明細の数と値が食い違う経路を作らないためにまとめた。
 * ⚠ 値の行は目印、継ぎ行は番地で入れる（雛形に目印を 600 個増やさないための分担）。
 *   目印を入れた後でないと、番地の衝突を見つけられない。
 * @param pictures Picture 欄に貼る絵。⚠ 空なら図形のパーツを 1 つも足さない。
 */
export async function renderOrderSheetXlsx(
  input: XlsxInput,
  pictures: readonly XlsxPicture[] = [],
): Promise<Uint8Array> {
  const lineCount = input.lines.length;
  const values = buildTokenValues(input);
  const refs = buildCellRefs(input);
  const total = totalQuantityOf(values, lineCount);

  // ⚠ 枠の外（落とした枠）に錨を打つ絵は貼らない。名指しで warn する。
  const placed = pictures.filter((picture) => {
    if (picture.lineIndex < lineCount) return true;
    console.warn(`[order-sheets] 明細 ${picture.lineIndex + 1} は無いので、写真を貼りません`);
    return false;
  });

  const encoder = new TextEncoder();
  const drawing = buildDrawingParts(placed);
  const entries = Object.entries(ORDER_SHEET_TEMPLATE).map(([path, xml]) => ({
    path,
    data: encoder.encode(patchPart(path, xml, { lineCount, total, values, refs }, drawing)),
  }));

  return buildZip([...entries, ...(drawing?.entries ?? [])]);
}

function patchPart(
  path: string,
  xml: string,
  sheet: {
    lineCount: number;
    total: number;
    values: Readonly<Record<string, CellValue>>;
    refs: Readonly<Record<string, CellValue>>;
  },
  drawing: DrawingParts | null,
): string {
  if (path === "xl/worksheets/sheet1.xml") {
    // ⚠ **削ってから差し込む。** 落とす枠の目印ごと消えるので、差し込み側は枠の数を知らなくてよい。
    const fitted = fitSheetToLines(xml, sheet.lineCount, sheet.total);
    const filled = injectCellsByRef(injectCells(fitted, sheet.values), sheet.refs);
    if (!drawing) return filled;
    /*
     * ⚠ `<drawing>` は OOXML の順序で**最後のほう**（`rowBreaks` より後ろ）。
     *   `</worksheet>` の直前に置けば必ず正しい位置になる。
     * ⚠ root は既に `xmlns:r` を宣言しているので namespace は足さなくてよい。
     */
    return filled.replace("</worksheet>", `${drawing.sheetTag}</worksheet>`);
  }

  // ⚠⚠ 印刷範囲。雛形のまま（実物の `$A$1:$L$31`）だと合計が刷られない。
  if (path === "xl/workbook.xml") return fitWorkbookToLines(xml, sheet.lineCount);

  if (path === "[Content_Types].xml" && drawing) {
    /*
     * ⚠⚠ **雛形の作り直しが `Default Extension="(png|jpg|bin)"` を消している**ので、
     *   画像を入れるときは必ず足し直す。無いと Excel が「修復が必要」と言う。
     */
    return xml.replace("</Types>", `${drawing.contentTypes.join("")}</Types>`);
  }

  return xml;
}
