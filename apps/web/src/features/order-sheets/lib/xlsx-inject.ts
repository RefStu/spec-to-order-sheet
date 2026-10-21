/**
 * ★ 雛形の `{{目印}}` を値に差し替える。
 *
 * ⚠⚠ **文字だけを置き換えない。** 雛形のセルは `t="inlineStr"` なので、
 *   文字だけ差し替えると**数値も日付も文字列として入る**(合計が出ず、日付も揃わない)。
 *   `<c>` を丸ごと作り直し、`t` を値の型から決め直す。
 * ⚠ `r`(セルの位置) と `s`(書式) は**必ず残す**。落とすと罫線も日付の書式も消える。
 * ⚠ 値が `null` の欄は**空のセル**にする (書式は残る)。「読めなかった」を空欄で表す。
 */

/** セル 1 つ (`<c .../>` か `<c ...>…</c>`)。 */
const CELL_RE = /<c\b[^>]*?\/>|<c\b[^>]*?>[\s\S]*?<\/c>/g;
const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/;

export type CellValue = string | number | null;

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Excel のシリアル値。**エポックは 1899-12-30**。
 * ⚠ UTC で計算する。ローカル時刻で計算すると、時差のある環境で 1 日ずれる。
 */
export function excelSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const days =
    (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 86_400_000;
  return Math.round(days);
}

/** `r="B16"` と `s="99"` だけを残した属性。 */
function keepAttributes(cell: string): string {
  const ref = /\sr="([^"]+)"/.exec(cell);
  const style = /\ss="([^"]+)"/.exec(cell);
  return `${ref ? ` r="${ref[1]}"` : ""}${style ? ` s="${style[1]}"` : ""}`;
}

function renderCell(attributes: string, value: CellValue): string {
  if (value === null || value === "") return `<c${attributes}/>`;
  if (typeof value === "number") return `<c${attributes}><v>${value}</v></c>`;
  // ⚠ 共有文字列表 (sharedStrings) は雛形から落としてあるので、必ずインライン文字列。
  return `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

export class UnknownToken extends Error {}

/**
 * `sheet1.xml` の目印を差し替える。
 *
 * @param values 目印 → 値。**渡されなかった目印は空欄になる**(使わない明細の枠)。
 * @throws UnknownToken 雛形に無い目印を渡したとき (綴り間違いを黙って捨てない)。
 */
export function injectCells(sheetXml: string, values: Readonly<Record<string, CellValue>>): string {
  const seen = new Set<string>();

  const out = sheetXml.replace(CELL_RE, (cell) => {
    const token = TOKEN_RE.exec(cell);
    if (!token) return cell;
    const name = token[1]!;
    seen.add(name);
    return renderCell(keepAttributes(cell), values[name] ?? null);
  });

  for (const name of Object.keys(values)) {
    if (!seen.has(name)) {
      throw new UnknownToken(`雛形にない目印です: ${name}`);
    }
  }
  return out;
}

/** 雛形にない番地を渡したとき。 */
export class UnknownCellRef extends Error {}

/** 目印のあるセルを番地で上書きしようとしたとき。 */
export class CellRefCollision extends Error {}

/**
 * `sheet1.xml` の**番地**を指して中身を入れる（`{"F17": "POLISH"}`）。
 *
 * 明細の継ぎ行は目印を置いていない（1 明細 50 セル × 12 = 600 個になって雛形が太る）ので、
 * 雛形の**空のセル**をそのまま使う。⚠ `r` と `s` は残すので、**罫線と折り返しの書式は
 * 雛形のまま**になる。
 *
 * ⚠ `injectCells()` の**後**に呼ぶこと（先に呼ぶと目印がまだ残っていて衝突を見つけられない）。
 * @throws UnknownCellRef 雛形に無い番地を渡したとき（綴り間違いを黙って捨てない）。
 * @throws CellRefCollision 目印のあるセルを指したとき（値の行を二重に書かない）。
 */
export function injectCellsByRef(
  sheetXml: string,
  values: Readonly<Record<string, CellValue>>,
): string {
  const wanted = new Map(Object.entries(values));
  if (wanted.size === 0) return sheetXml;
  const seen = new Set<string>();

  const out = sheetXml.replace(CELL_RE, (cell) => {
    const ref = /\sr="([^"]+)"/.exec(cell)?.[1];
    if (ref === undefined || !wanted.has(ref)) return cell;
    if (TOKEN_RE.test(cell)) {
      throw new CellRefCollision(`目印のあるセルです: ${ref}`);
    }
    seen.add(ref);
    return renderCell(keepAttributes(cell), wanted.get(ref) ?? null);
  });

  for (const ref of wanted.keys()) {
    if (!seen.has(ref)) throw new UnknownCellRef(`雛形にない番地です: ${ref}`);
  }
  return out;
}
