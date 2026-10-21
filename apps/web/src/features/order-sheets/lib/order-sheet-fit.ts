/**
 * ★★ 12 枠の雛形を、**明細の数だけの枠**に削る。
 *
 * 元にした実物の xlsx（非公開）は明細 2 件で「枠 2 個 (行 15〜26) → 空き行 27 →
 * 合計 28 (`SUM(I15:I26)` と `PCS`)」の形をしている。雛形は 12 枠 (合計 88) で作ってあるので、
 * 描き出すときに **N 枠目より後ろの行を落とし、合計の行を上げる**。
 *
 * 直すもの (どれか 1 つでも取り残すと紙が崩れる):
 *   - 行 (`<row>` とセルの番地) … 落とした行より下を上へずらす
 *   - `I<合計>` の `SUM` の範囲と、`G7` の `SUM(I<合計>)`
 *   - `mergeCells` … 落とす行に掛かるものがあれば**例外**（いまは行 2〜8 にしか無い）
 *   - `dimension` / `rowBreaks` (改ページ) / 印刷範囲 (`workbook.xml` の `_xlnm.Print_Area`)
 *   - 図の錨 … 枠の幾何は動かさないので**直すものは無い**（`pictureAnchorRow()` のまま）
 *
 * ⚠⚠ **「I88 の挙動がおかしい」の中身 (再現した)。** 雛形は実物の
 *   印刷範囲 `$A$1:$L$31` と改ページ `brk id=34` をそのまま持っていたので、
 *   12 枠にしても**行 31 より下は印刷されず**、開いたときの改ページプレビュー
 *   (実物の既定の表示) では **`I88` の合計が灰色の「印刷しない」領域**に居た。
 *   明細 3 件目の途中で紙が切れ、合計は紙に出ない。加えて数式のキャッシュ値が無く、
 *   再計算しないビューアでは合計が空に見えた。ここで 3 つとも直す。
 * ⚠ 枠の幾何 (`FIRST_BLOCK_ROW` / `BLOCK_ROWS` / `VALUE_ROW`) は動かさない。
 *   値のセルの番地 (F16 / F22 …) は変わらないので、保存済みのデータに影響しない。
 */

import {
  BLOCK_ROWS,
  blockCountOf,
  FIRST_BLOCK_ROW,
  lastBlockRowOf,
  PRINT_AREA_ROWS_BELOW_TOTAL,
  PRINT_TITLE_ROWS,
  TEMPLATE_TOTAL_ROW,
  totalRowOf,
} from "./order-sheet-layout";

const ROW_RE = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
const CELL_RE = /<c\b[^>]*?\/>|<c\b[^>]*?>[\s\S]*?<\/c>/g;

/** 雛形が壊れていて削れないとき（黙ってずれた xlsx を出さない）。 */
export class TemplateShapeError extends Error {}

function rowNumberOf(rowXml: string): number {
  const r = /<row\b[^>]*?\sr="(\d+)"/.exec(rowXml)?.[1];
  if (r === undefined) throw new TemplateShapeError("行番号の無い <row> があります");
  return Number(r);
}

/** 行を `to` 行目へ動かす（行の `r` とセルの番地の両方）。 */
function moveRow(rowXml: string, to: number): string {
  return rowXml
    .replace(/(<row\b[^>]*?\sr=")\d+(")/, `$1${to}$2`)
    .replace(/(<c\b[^>]*?\sr="[A-Z]+)\d+(")/g, `$1${to}$2`);
}

/**
 * 数式のセルを作り直す（`r` と `s` は残す）。
 *
 * ⚠ **数式は残す**（人が Excel で明細を直したら合計が追従する）。
 * ⚠ `<v>` はキャッシュ値。Excel は `fullCalcOnLoad` で計算し直すが、
 *   再計算しないビューアはこれをそのまま出す。**`SUM` と同じ数**を渡すこと。
 */
function setFormula(sheetXml: string, ref: string, formula: string, cached: number | null): string {
  let found = false;
  const out = sheetXml.replace(CELL_RE, (cell) => {
    if (/\sr="([^"]+)"/.exec(cell)?.[1] !== ref) return cell;
    if (!/<f>/.test(cell)) throw new TemplateShapeError(`${ref} に数式がありません`);
    found = true;
    const style = /\ss="([^"]+)"/.exec(cell)?.[1];
    const value = cached === null ? "" : `<v>${cached}</v>`;
    return `<c r="${ref}"${style ? ` s="${style}"` : ""}><f>${formula}</f>${value}</c>`;
  });
  if (!found) throw new TemplateShapeError(`雛形に ${ref} がありません`);
  return out;
}

/** `A1:L91` の行を 1 つ動かす。 */
function shiftRange(range: string, removeFrom: number, removeTo: number, shift: number): string {
  return range.replace(/([A-Z]+)(\d+)/g, (_all, column: string, row: string) => {
    const r = Number(row);
    if (r >= removeFrom && r <= removeTo) {
      throw new TemplateShapeError(`落とす行に結合セルが掛かっています: ${range}`);
    }
    return `${column}${r > removeTo ? r - shift : r}`;
  });
}

/** 行の高さ（pt）。`ht` が無い行と、`<row>` の無い行は既定の高さ。 */
function rowHeights(sheetXml: string): (row: number) => number {
  const fallback = Number(
    /<sheetFormatPr\b[^>]*\sdefaultRowHeight="([\d.]+)"/.exec(sheetXml)?.[1] ?? 15,
  );
  const heights = new Map<number, number>();
  for (const m of sheetXml.matchAll(ROW_RE)) {
    const ht = /<row\b[^>]*?\sht="([\d.]+)"/.exec(m[0])?.[1];
    if (ht !== undefined) heights.set(rowNumberOf(m[0]), Number(ht));
  }
  return (row) => heights.get(row) ?? fallback;
}

/** 用紙の縦横（pt）。⚠ 知らない用紙は null（改ページは Excel に任せる）。 */
const PAPER_PT: Readonly<Record<string, readonly [number, number]>> = {
  "1": [612, 792], // Letter
  "9": [595.28, 841.89], // A4
};

/**
 * 1 ページに刷れるシートの高さ（pt、縮尺を戻した値）。
 *
 * ⚠ 余白は `pageMargins` の上下（インチ）。ヘッダ/フッタは余白の内側に刷られる。
 * ⚠ 見積もりが実際より大きいと、Excel が枠の途中で自動の改ページを入れてしまう。
 *   それを避けるため、少し（`PAGE_SAFETY`）小さめに見積もる。
 */
const PAGE_SAFETY = 0.97;

function printableHeight(sheetXml: string): number | null {
  // ⚠ 「1 ページに収める」指定なら縮尺が変わるので、見積もれない。
  if (/<pageSetUpPr\b[^>]*\sfitToPage="(1|true)"/.test(sheetXml)) return null;
  const setup = /<pageSetup\b[^>]*>/.exec(sheetXml)?.[0];
  const margins = /<pageMargins\b[^>]*>/.exec(sheetXml)?.[0];
  if (!setup || !margins) return null;
  const paper = PAPER_PT[/\spaperSize="(\d+)"/.exec(setup)?.[1] ?? "1"];
  if (!paper) return null;
  const landscape = /\sorientation="landscape"/.test(setup);
  const pageHeight = landscape ? Math.min(...paper) : Math.max(...paper);
  const scale = Number(/\sscale="(\d+)"/.exec(setup)?.[1] ?? 100) / 100;
  const top = Number(/\stop="([\d.]+)"/.exec(margins)?.[1] ?? 0.75);
  const bottom = Number(/\sbottom="([\d.]+)"/.exec(margins)?.[1] ?? 0.75);
  return ((pageHeight - (top + bottom) * 72) / scale) * PAGE_SAFETY;
}

/**
 * ★★ 改ページを入れる行（**その行の下で改ページ**。`<brk id>` の値そのもの）。
 *
 * 枠 (明細 1 件 = 6 行) の**途中では切らない**。1 ページ目は行 1 から、2 ページ目以降は
 * 繰り返しの見出し (`PRINT_TITLE_ROWS`) の下から積み、次の枠が入らなければその前で切る。
 * 最後の枠と「空き行 + 合計」も離さない（合計だけが次のページに行かないように）。
 *
 * ⚠⚠ **実物の改ページ (`brk id=34`) は使わない。** 実物は枠 2 個で印刷範囲が行 31 まで
 *   なので効いていなかったが、雛形の 12 枠では**4 件目の枠の途中**に刺さっていた。
 * @param sheetXml **削った後の** `sheet1.xml`（行の高さと用紙の設定をここから読む）。
 */
export function pageBreakRowsOf(sheetXml: string, lineCount: number): number[] {
  const capacity = printableHeight(sheetXml);
  if (capacity === null) return [];
  const height = rowHeights(sheetXml);
  const sum = (from: number, to: number) => {
    let total = 0;
    for (let row = from; row <= to; row++) total += height(row);
    return total;
  };

  const blocks = blockCountOf(lineCount);
  const totalRow = totalRowOf(lineCount);
  const titles = sum(PRINT_TITLE_ROWS.first, PRINT_TITLE_ROWS.last);
  const breaks: number[] = [];
  let used = sum(1, FIRST_BLOCK_ROW - 1);
  let blocksOnPage = 0;

  for (let index = 0; index < blocks; index++) {
    const start = FIRST_BLOCK_ROW + index * BLOCK_ROWS;
    const block = sum(start, start + BLOCK_ROWS - 1);
    // ⚠ ページの先頭の枠は、入らなくても置く（それ以上は割れない）。
    if (blocksOnPage > 0 && used + block > capacity) {
      breaks.push(start - 1);
      used = titles;
      blocksOnPage = 0;
    }
    used += block;
    blocksOnPage += 1;
  }

  // 空き行と合計が入らなければ、最後の枠ごと次のページへ送る。
  if (used + sum(totalRow - 1, totalRow) > capacity) {
    const lastStart = FIRST_BLOCK_ROW + (blocks - 1) * BLOCK_ROWS;
    breaks.push(blocksOnPage > 1 ? lastStart - 1 : lastBlockRowOf(lineCount));
  }
  return breaks;
}

function rowBreaksXml(breaks: readonly number[]): string {
  if (breaks.length === 0) return "";
  // ⚠ `max="11"` は L 列（0 始まり）まで。実物の `brk` と同じ形。
  const items = breaks.map((row) => `<brk id="${row}" max="11" man="1"/>`).join("");
  return `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${items}</rowBreaks>`;
}

/**
 * ★★ `sheet1.xml` を明細の数に合わせて削る。
 *
 * @param templateXml **雛形の** `sheet1.xml`（目印の入った 12 枠のもの）。
 *   ⚠ 値を差し込む**前**に呼ぶ（落とす枠の目印ごと消えるので、差し込み側が迷わない）。
 * @param total 合計の数（`SUM` と同じ数）。`<v>` に入れる。null なら入れない。
 */
export function fitSheetToLines(
  templateXml: string,
  lineCount: number,
  total: number | null,
): string {
  const blocks = blockCountOf(lineCount);
  const totalRow = totalRowOf(lineCount);
  const removeFrom = FIRST_BLOCK_ROW + blocks * BLOCK_ROWS;
  const removeTo = TEMPLATE_TOTAL_ROW - 2;
  const shift = removeTo - removeFrom + 1;

  // 1) 行を落として、下の行を上げる。
  let xml = templateXml.replace(/<sheetData>([\s\S]*?)<\/sheetData>/, (_all, body: string) => {
    const rows = body.replace(ROW_RE, (row) => {
      const r = rowNumberOf(row);
      if (r >= removeFrom && r <= removeTo) return "";
      return r > removeTo && shift > 0 ? moveRow(row, r - shift) : row;
    });
    return `<sheetData>${rows}</sheetData>`;
  });

  // 2) 合計の数式（範囲は枠の先頭から最後の枠の末尾まで。実物は `SUM(I15:I26)`）。
  xml = setFormula(
    xml,
    `I${totalRow}`,
    `SUM(I${FIRST_BLOCK_ROW}:I${lastBlockRowOf(lineCount)})`,
    total,
  );
  xml = setFormula(xml, "G7", `SUM(I${totalRow})`, total);

  // 3) 結合セル。
  xml = xml.replace(
    /<mergeCell ref="([^"]+)"\/>/g,
    (_all, range: string) => `<mergeCell ref="${shiftRange(range, removeFrom, removeTo, shift)}"/>`,
  );

  // 4) dimension は実際にある最後の行まで（実物は合計 28 に対して `A1:L30`）。
  const lastRow = Math.max(...[...xml.matchAll(ROW_RE)].map((m) => rowNumberOf(m[0])));
  xml = xml.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+(")/, `$1${lastRow}$2`);

  // 5) 改ページ。⚠ 雛形の `brk id=34` は捨てて、枠の境目に置き直す。
  const breaks = rowBreaksXml(pageBreakRowsOf(xml, lineCount));
  if (/<rowBreaks\b/.test(xml)) {
    xml = xml.replace(/<rowBreaks\b[^>]*\/>|<rowBreaks\b[^>]*>[\s\S]*?<\/rowBreaks>/, breaks);
  } else if (breaks !== "") {
    // ⚠ OOXML の順序で `headerFooter` の直後（`drawing` より前）。
    xml = /<\/headerFooter>/.test(xml)
      ? xml.replace("</headerFooter>", `</headerFooter>${breaks}`)
      : xml.replace("</worksheet>", `${breaks}</worksheet>`);
  }
  return xml;
}

/**
 * ★ 印刷範囲（`workbook.xml` の `_xlnm.Print_Area`）を合計の下まで広げる。
 *
 * ⚠⚠ **ここが「I88 が刷られない」の直接の原因だった。** 雛形は実物の `$A$1:$L$31`
 *   (枠 2 個ぶん) のままで、12 枠の雛形でも行 31 で紙が切れていた。
 */
export function fitWorkbookToLines(workbookXml: string, lineCount: number): string {
  const last = totalRowOf(lineCount) + PRINT_AREA_ROWS_BELOW_TOTAL;
  const re = /(<definedName\b[^>]*name="_xlnm\.Print_Area"[^>]*>[^<]*\$)\d+(<\/definedName>)/;
  if (!re.test(workbookXml)) throw new TemplateShapeError("雛形に印刷範囲がありません");
  return workbookXml.replace(re, `$1${last}$2`);
}
