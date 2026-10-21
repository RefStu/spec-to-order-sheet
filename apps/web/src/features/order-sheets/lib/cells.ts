/**
 * ★★ 明細の**セルの地図**の読み書き。**分け方を知っているのはここだけ。**
 *
 * `order_sheet_lines.cells_json` に入っているのは
 * `{"<xlsx の番地>": "値"}` の疎な地図（`"F16"` = 行 16 の F 列）。
 *
 * ⚠ 鍵の形の正は `order-sheet-layout.ts` の `lineCellRef()` / `parseLineCellRef()`。ここは使うだけ。
 * ⚠⚠ **相対（`"F:0"`）から絶対番地へ変えた。**
 *   番地は**その明細の行番号を含む**ので、**どの明細の地図かと食い違っていたら捨てる**
 *   （`lineIndex` を渡すとそこまで見る）。食い違いを黙って通すと、画面の塗り分けと
 *   来歴の突き合わせが**例外なしでずれる**。
 * ⚠⚠ **空のセルは鍵ごと入れない。** 枠は 60 セルあるが実物で埋まるのは 10 ほどなので、
 *   `null` を並べると地図が読みにくいうえに無駄に太る。
 */

import { isHeaderCellRef, isLineCellRef, parseLineCellRef } from "./order-sheet-layout";

/** セルの地図（値は文字列。型の扱いを知っているのは xlsx を書くところだけ）。 */
export type CellMap = Record<string, string>;

/**
 * `cells_json` を読む。
 *
 * ⚠⚠ **壊れていてもシートごと落とさない。** 画面が開かなくなるほうが困る。
 *   読めない鍵は**名指しで warn して捨てる**（黙って形を変えない）。
 */
export function parseCells(json: string | null | undefined, lineIndex?: number): CellMap {
  if (json === null || json === undefined || json.trim().length === 0) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn("[order-sheets] cells_json が JSON として読めません");
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn("[order-sheets] cells_json が地図の形ではありません");
    return {};
  }

  const cells: CellMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isLineCellRef(key)) {
      console.warn(`[order-sheets] 知らないセルの番地です: ${key}`);
      continue;
    }
    // ⚠ 別の明細の番地が紛れ込んでいたら捨てる（黙って別の行の値として出さない）。
    if (lineIndex !== undefined && parseLineCellRef(key)?.lineIndex !== lineIndex) {
      console.warn(`[order-sheets] 明細 ${lineIndex + 1} の地図に別の枠の番地があります: ${key}`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.length === 0) continue;
    cells[key] = text;
  }
  return cells;
}

/**
 * 地図を `cells_json` にする。
 *
 * ⚠ **鍵を並べ替えて書く。** 同じ中身なら同じ文字列になるので、差分が読める。
 */
export function serializeCells(cells: CellMap): string {
  const sorted = Object.keys(cells).sort();
  return JSON.stringify(Object.fromEntries(sorted.map((key) => [key, cells[key]!])));
}

/**
 * ★ ヘッダの地図（`order_sheets.cells_json`）を読む。
 *
 * ⚠ 通すのは**人が打つセル**（`J5` / `J7` / `D12` / `F12` ＋ 工程表の `C4:E10`）だけ。
 *   ⚠ 門番は `isHeaderCellRef()`（= `HEADER_CELLS` からの導出）なので、**一覧はここに持たない**。
 *   派生（`A12` / `J12` / `F5`）が紛れていたら捨てる — 書き手が居ないので、
 *   入っていること自体が壊れている合図。
 * ⚠⚠ **壊れていてもシートごと落とさない**（明細側と同じ）。
 */
export function parseHeaderCells(json: string | null | undefined): CellMap {
  const cells: CellMap = {};
  for (const [key, value] of Object.entries(parseAny(json))) {
    if (!isHeaderCellRef(key)) {
      console.warn(`[order-sheets] ヘッダに置けないセルの番地です: ${key}`);
      continue;
    }
    cells[key] = value;
  }
  return cells;
}

/** 鍵を見ずに JSON を地図として読む（`parseCells` / `parseHeaderCells` の下ごしらえ）。 */
function parseAny(json: string | null | undefined): CellMap {
  if (json === null || json === undefined || json.trim().length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn("[order-sheets] cells_json が JSON として読めません");
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn("[order-sheets] cells_json が地図の形ではありません");
    return {};
  }
  const cells: CellMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.length === 0) continue;
    cells[key] = text;
  }
  return cells;
}
