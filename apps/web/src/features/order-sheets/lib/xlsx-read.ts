/**
 * ★ 出した xlsx を**読み返す**ための小さな道具（**テスト専用**。アプリの経路からは呼ばない）。
 *
 * ⚠ 「画面の文字がそのまま xlsx に入る」を確かめるには、**出力の xlsx そのもの**を
 *   見るしかない。`order-sheet-render.test.ts` と `api/routes.test.ts` が同じものを使うので、
 *   ここに 1 つだけ置く（テストどうしで写さない）。
 * ⚠ 読めるのは `buildZip()` が作る形（無圧縮か deflate-raw、データ記述子なし）だけ。
 */

/** zip を展開して `path` の中身を文字として取り出す。 */
export async function readZipText(zip: Uint8Array, path: string): Promise<string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let at = 0;
  while (at + 30 <= zip.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const bodyAt = at + 30 + nameLen + extraLen;
    const body = zip.subarray(bodyAt, bodyAt + size);
    if (name === path) {
      const bytes =
        method === 0
          ? body
          : new Uint8Array(
              await new Response(
                new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
              ).arrayBuffer(),
            );
      return new TextDecoder().decode(bytes);
    }
    at = bodyAt + size;
  }
  throw new Error(`${path} が無い`);
}

/** zip を展開して `sheet1.xml` を取り出す。 */
export function sheetXml(zip: Uint8Array): Promise<string> {
  return readZipText(zip, "xl/worksheets/sheet1.xml");
}

/**
 * `sheet1.xml` のセル 1 つの**文字**（インライン文字列の `<t>` か、数値の `<v>`）。空なら null。
 * ⚠ XML の実体参照（`&amp;` など）は戻さない。テストの値に `& < > "` を使わないこと。
 */
export function cellOf(xml: string, ref: string): string | null {
  const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>(.*?)</c>)`, "s").exec(xml);
  if (!m) return null;
  const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(m[1] ?? "");
  const v = /<v>([\s\S]*?)<\/v>/.exec(m[1] ?? "");
  return t ? t[1]! : v ? v[1]! : null;
}

/** そのセルが**文字のセル**（`t="inlineStr"`）か。数値のセルなら false。 */
export function isTextCell(xml: string, ref: string): boolean {
  return new RegExp(`<c r="${ref}"[^>]*\\st="inlineStr"`).test(xml);
}
