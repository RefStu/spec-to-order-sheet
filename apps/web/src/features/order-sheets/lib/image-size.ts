/**
 * ★ 画像の**画素数**を読む（JPEG と PNG）。
 *
 * xlsx に写真を貼るとき、**縦横比を保って枠に収める**ために元の大きさが要る。
 *
 * ⚠⚠ **依存を足さない。** `apps/web` は Worker で `node:*` も `Buffer` も無く、
 *   画像ライブラリはどれも node 前提。必要なのは「ヘッダを読む」だけなので自分で読む。
 * ⚠ **中身は展開しない。** 画素を触る必要はないし、Worker の CPU 時間もかけたくない。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * 画素数を読む。**読めなければ null**（呼び手が名指しで warn して飛ばす）。
 *
 * ⚠ 黙って既定の大きさを当てない。当てると**比の狂った写真が静かに貼られる**。
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes);
}

/** PNG は `IHDR` が必ず先頭にある（8 バイトの署名 + 長さ + "IHDR" + 幅 + 高さ）。 */
function pngSize(bytes: Uint8Array): ImageSize | null {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return null;
  }
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
}

/**
 * JPEG は marker を辿って **SOF**（`0xFFC0`〜`0xFFCF`）を探す。
 *
 * ⚠ `C4`(ハフマン表) / `C8`(予約) / `CC`(算術符号の表) は**大きさを持たない**ので飛ばす。
 *   ここを弾かないと、表の中身を縦横として読んでしまう。
 */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;
  while (at + 3 < bytes.length) {
    // ⚠ marker の前に 0xFF が続くことがある（詰め物）。
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // データを持たない marker。
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = readU16(bytes, at + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOF: 長さ(2) 精度(1) 高さ(2) 幅(2)
      if (at + 9 >= bytes.length) return null;
      return { width: readU16(bytes, at + 7), height: readU16(bytes, at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

function readU16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}
