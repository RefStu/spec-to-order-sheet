import { describe, expect, it } from "vitest";
import { imageSize } from "./image-size";

/**
 * ⚠ **実物を fixture にしない** (実物の写真には取引先の情報が入っている)。
 *   ヘッダだけを手で組む。
 */
function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0, 0, 0, 13], 8);
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

/** `segments` は [marker, ...payload]（payload には長さの 2 バイトを含めない）。 */
function jpeg(segments: [number, ...number[]][]): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  for (const [marker, ...payload] of segments) {
    parts.push(0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff);
    parts.push(...payload);
  }
  return Uint8Array.from(parts);
}

const sof = (marker: number, width: number, height: number): [number, ...number[]] => [
  marker,
  8, // 精度
  (height >> 8) & 0xff,
  height & 0xff,
  (width >> 8) & 0xff,
  width & 0xff,
  3, // 成分の数
];

describe("imageSize", () => {
  it("PNG は IHDR から読む", () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("JPEG は SOF0 から読む", () => {
    expect(imageSize(jpeg([sof(0xc0, 800, 600)]))).toEqual({ width: 800, height: 600 });
  });

  /** ⚠ プログレッシブ JPEG は SOF2。切り出した写真がこの形のことがある。 */
  it("JPEG は SOF2 (プログレッシブ) も読む", () => {
    expect(imageSize(jpeg([sof(0xc2, 300, 200)]))).toEqual({ width: 300, height: 200 });
  });

  /**
   * ⚠⚠ **ハフマン表 (`C4`) を SOF と間違えない。** 範囲だけで拾うと、表の中身を
   *   縦横として読んで**比の狂った写真が静かに貼られる**。
   */
  it("⚠⚠ ハフマン表 (C4) を飛ばして本当の SOF を読む", () => {
    const bytes = jpeg([[0xc4, 0, 1, 2, 3, 4], sof(0xc0, 120, 90)]);
    expect(imageSize(bytes)).toEqual({ width: 120, height: 90 });
  });

  it("前に APP0 (JFIF) が付いていても読む", () => {
    const bytes = jpeg([[0xe0, 0x4a, 0x46, 0x49, 0x46, 0], sof(0xc0, 64, 32)]);
    expect(imageSize(bytes)).toEqual({ width: 64, height: 32 });
  });

  /** ⚠ 読めないものに既定値を当てない (比の狂った写真を静かに貼らない)。 */
  it("⚠ 知らない形式は null", () => {
    expect(imageSize(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
    // SOF が来ないまま終わる JPEG。
    expect(imageSize(jpeg([[0xe0, 1, 2, 3]]))).toBeNull();
  });
});
