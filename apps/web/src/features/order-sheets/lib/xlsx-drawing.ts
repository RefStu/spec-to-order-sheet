/**
 * ★★ xlsx に**写真を入れて、該当の枠に置く**。
 *
 * xlsx は zip なので、これは 3 つに分かれる:
 *
 * ```
 * xl/media/image1.jpg        ← 写真のバイト列をそのまま入れる
 * xl/drawings/drawing1.xml   ← 「E 列・その枠の先頭行に、この大きさで置く」という錨
 * xl/worksheets/sheet1.xml   ← <drawing r:id="rIdN"/> で上の錨を呼ぶ
 * ```
 *
 * ⚠⚠ **雛形には焼かない。** 実物の image1.png は 3.4MB あり、載せるとバンドルが太るだけ。
 *   写真は案件ごとに違うので、**描き出すときにその場で**パーツを足す。
 *   ⚠ 雛形側に `<drawing>` を書く案は採れない — 雛形の生成が `r:id` を
 *   無差別に剥がすので、**雛形を作り直すたびに黙って消える**。
 * ⚠ 写真が 1 枚も無いときは**パーツを 1 つも足さない**（元の 7 パーツの xlsx に戻る）。
 */

import { imageSize } from "./image-size";
import { PICTURE_ANCHOR, pictureAnchorRow } from "./order-sheet-layout";
import type { ZipEntry } from "./xlsx-zip";

/** xlsx に貼る写真 1 枚。 */
export interface XlsxPicture {
  /** 何件目の明細か（**0 始まり**）。 */
  lineIndex: number;
  bytes: Uint8Array;
  /** `image/jpeg` など。⚠ 拡張子はここから決める。 */
  contentType: string;
}

export interface DrawingParts {
  /** zip に足すパーツ。 */
  entries: ZipEntry[];
  /** `sheet1.xml` の `</worksheet>` の直前に入れるもの。 */
  sheetTag: string;
  /** `[Content_Types].xml` に足す宣言。 */
  contentTypes: string[];
}

const DRAWING_PATH = "xl/drawings/drawing1.xml";
const SHEET_RELS_PATH = "xl/worksheets/_rels/sheet1.xml.rels";
const DRAWING_RELS_PATH = "xl/drawings/_rels/drawing1.xml.rels";

/** ⚠ Excel が読める形だけを通す。知らない形式は貼らない（名指しで warn する）。 */
const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
};

/**
 * 写真から zip のパーツを組み立てる。
 *
 * ⚠ **読めなかった写真は名指しで warn して飛ばす。** 写真 1 枚のせいで
 *   ダウンロードそのものを落とさない（xlsx は出る、その絵だけが無い）。
 */
export function buildDrawingParts(pictures: readonly XlsxPicture[]): DrawingParts | null {
  const usable = pictures.filter((picture, index) => {
    const extension = EXTENSION[picture.contentType.toLowerCase()];
    if (extension === undefined) {
      console.warn(`[order-sheets] xlsx に貼れない形式です: ${picture.contentType} (${index} 枚目)`);
      return false;
    }
    if (imageSize(picture.bytes) === null) {
      console.warn(`[order-sheets] 画素数が読めませんでした (明細 ${picture.lineIndex + 1})`);
      return false;
    }
    return true;
  });
  if (usable.length === 0) return null;

  const media: ZipEntry[] = [];
  const anchors: string[] = [];
  const rels: string[] = [];
  const extensions = new Set<string>();

  usable.forEach((picture, index) => {
    const id = index + 1;
    const extension = EXTENSION[picture.contentType.toLowerCase()]!;
    extensions.add(extension);
    media.push({ path: `xl/media/image${id}.${extension}`, data: picture.bytes });
    rels.push(
      `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${id}.${extension}"/>`,
    );
    anchors.push(anchorXml(id, picture));
  });

  const drawing =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    anchors.join("") +
    `</xdr:wsDr>`;

  const encoder = new TextEncoder();
  return {
    entries: [
      ...media,
      { path: DRAWING_PATH, data: encoder.encode(drawing) },
      { path: DRAWING_RELS_PATH, data: encoder.encode(relsXml(rels.join(""))) },
      {
        path: SHEET_RELS_PATH,
        data: encoder.encode(
          relsXml(
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`,
          ),
        ),
      },
    ],
    sheetTag: `<drawing r:id="rId1"/>`,
    contentTypes: [
      ...[...extensions].map(
        (extension) =>
          `<Default Extension="${extension}" ContentType="image/${extension === "jpeg" ? "jpeg" : "png"}"/>`,
      ),
      `<Override PartName="/${DRAWING_PATH}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    ],
  };
}

/**
 * 錨 1 つ。
 *
 * ⚠⚠ **縦横比を保つ。** 箱に引き伸ばすと写真が歪む。内接する大きさにして、
 *   余った分の半分を `colOff` / `rowOff` に入れて**枠の中央**に置く。
 */
function anchorXml(id: number, picture: XlsxPicture): string {
  const size = imageSize(picture.bytes)!;
  const { boxWidthEmu, boxHeightEmu, col } = PICTURE_ANCHOR;
  // 1 px = 9525 EMU（96dpi）。
  const naturalWidth = size.width * 9525;
  const naturalHeight = size.height * 9525;
  const scale = Math.min(boxWidthEmu / naturalWidth, boxHeightEmu / naturalHeight);
  const cx = Math.max(1, Math.round(naturalWidth * scale));
  const cy = Math.max(1, Math.round(naturalHeight * scale));

  const colOff = Math.round((boxWidthEmu - cx) / 2);
  const rowOff = Math.round((boxHeightEmu - cy) / 2);
  const row = pictureAnchorRow(picture.lineIndex);

  return (
    `<xdr:oneCellAnchor>` +
    `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff>` +
    `<xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    `<xdr:pic>` +
    `<xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${id}"/>` +
    // ⚠ 人が Excel で動かしても比が崩れないようにしておく。
    `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`
  );
}

function relsXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    body +
    `</Relationships>`
  );
}
