import { decode, encode } from "jpeg-js";
import type { NormalizedBox } from "./picture-box";
import type { RgbaImage } from "./snap-box";

/**
 * ページの絵から**代表の図の枠だけ**を切り出す。
 *
 * ⚠ 出すのは JPEG。写真なので PNG より小さく、`jpeg-js` だけで完結する
 *   (ネイティブ拡張も wasm も持ち込まない)。
 * ⚠⚠ **回転はここでは扱わない。** 渡ってくるのは `pdftoppm` が描いたページで、
 *   `/Rotate` は描くときに当たっている ＝ **モデルが見たのと同じ向き**。
 *   ここで回すと二重に回る。
 */

/** 切り出した絵の JPEG の品質。写真なので 85 で十分。 */
const QUALITY = 85;

/** 出来上がりがこれより小さいと、潰れていて使い物にならない。 */
const MIN_SIDE_PX = 24;

export const PICTURE_MEDIA_TYPE = "image/jpeg";

export interface CroppedPicture {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** RGBA の矩形を切り出す。 */
function cut(
  source: Uint8Array,
  sourceWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((top + row) * sourceWidth + left) * 4;
    out.set(source.subarray(from, from + width * 4), row * width * 4);
  }
  return out;
}

/**
 * `pdftoppm` が描いたページを RGBA に展開する。読めなければ null (写真の欄は空のまま)。
 *
 * ⚠ **ページごとに 1 回だけ呼ぶ。** 300 dpi の A4 は 2480 × 3506 px (約 35MB) あり、
 *   枠を寄せる (`snap-box.ts`) のにも切るのにも同じ絵を使う。以前は枠ごとに展開し直していた。
 */
export function decodePage(page: { jpeg: Uint8Array }): RgbaImage | null {
  try {
    const decoded = decode(page.jpeg, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true });
    return { data: decoded.data, width: decoded.width, height: decoded.height };
  } catch {
    return null;
  }
}

/**
 * 切り出す。切れなければ null (写真の欄は空のまま)。
 *
 * ⚠ 出来上がりの縦横比は**枠の画素の比**そのもの (拡大・縮小はしない)。
 *   縦横比を決めるのは枠の形で、ここではない (`snap-box.ts` の冒頭)。
 *
 * @param image `decodePage()` で展開したページ (**見たままの向き**)。
 * @param box ページに対する 0..1 の枠 (`usableBox` を通したもの)。
 */
export function cropPicture(image: RgbaImage, box: NormalizedBox): CroppedPicture | null {
  const left = Math.max(0, Math.round(box.x * image.width));
  const top = Math.max(0, Math.round(box.y * image.height));
  const width = Math.min(Math.round(box.width * image.width), image.width - left);
  const height = Math.min(Math.round(box.height * image.height), image.height - top);
  if (width < MIN_SIDE_PX || height < MIN_SIDE_PX) return null;

  const data = cut(image.data, image.width, left, top, width, height);
  const encoded = encode({ data, width, height }, QUALITY);
  return { jpeg: new Uint8Array(encoded.data), width, height };
}
