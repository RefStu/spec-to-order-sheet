import { describe, expect, it } from "vitest";
import { snapBox, type RgbaImage } from "./snap-box";

/**
 * ⚠⚠ **ここが「モデルの枠を図 1 つに寄せる」の固定**。
 *
 *   紙面は実物のサンプル (非公開) の p2 / p3 の形を真似て描く:
 *   - 写真は**塗りつぶした四角** (芯がある)
 *   - p2 の左端の図は、**ラベルごと細い枠線で囲まれた写真**
 *   - p3 の完成イメージは、**塗りの部分と細い輪郭の部分**があるイラストで、
 *     破線の引き出し線の先にラベルがある
 *   - 段と段の間は 20 px ほど (300 dpi)。モデルの枠は下へ伸びて次の段まで入る
 *
 * ⚠ 幅は 2480 px (300 dpi の A4) にしてある。`snap-box.ts` の px の値はこの幅が基準。
 */

const WIDTH = 2480;
const HEIGHT = 1200;

type Rgb = [number, number, number];
const GREY: Rgb = [150, 150, 150];
const BLACK: Rgb = [30, 30, 30];
const YELLOW: Rgb = [240, 200, 40];

function canvas(width = WIDTH, height = HEIGHT): RgbaImage {
  const data = new Uint8Array(width * height * 4).fill(255);
  return { data, width, height };
}

function fill(image: RgbaImage, x: number, y: number, w: number, h: number, color: Rgb) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const at = (row * image.width + col) * 4;
      image.data[at] = color[0];
      image.data[at + 1] = color[1];
      image.data[at + 2] = color[2];
    }
  }
}

/** 太さ `t` の枠線 (中は塗らない)。 */
function frame(image: RgbaImage, x: number, y: number, w: number, h: number, t = 3) {
  fill(image, x, y, w, t, BLACK);
  fill(image, x, y + h - t, w, t, BLACK);
  fill(image, x, y, t, h, BLACK);
  fill(image, x + w - t, y, t, h, BLACK);
}

/** 文字の代わり (細い画数の並び。芯を持たない)。 */
function label(image: RgbaImage, x: number, y: number, chars: number) {
  for (let i = 0; i < chars; i++) {
    fill(image, x + i * 22, y, 2, 20, BLACK);
    fill(image, x + i * 22, y + 9, 14, 2, BLACK);
  }
}

/** 縦の破線 (引き出し線)。 */
function dashes(image: RgbaImage, x: number, y: number, length: number) {
  for (let at = y; at < y + length; at += 10) fill(image, x, at, 2, 5, BLACK);
}

/** ピクセルの枠を割合にする (種を書くため)。 */
function seed(image: RgbaImage, x: number, y: number, w: number, h: number) {
  return { x: x / image.width, y: y / image.height, width: w / image.width, height: h / image.height };
}

/** 結果をピクセルに戻す (丸めの誤差を消すため)。 */
function pixels(image: RgbaImage, box: ReturnType<typeof snapBox>) {
  if (!box) return null;
  return {
    left: Math.round(box.x * image.width),
    top: Math.round(box.y * image.height),
    right: Math.round((box.x + box.width) * image.width),
    bottom: Math.round((box.y + box.height) * image.height),
  };
}

/** 寄せた枠の外に足す余白 (`PAD_PX`)。 */
const PAD = 4;

/** p2 の紙面: 1 段目 = [枠線 + ラベル + 写真] [写真] / 2 段目 = [写真] [写真]。 */
function p2Like() {
  const image = canvas();
  frame(image, 200, 100, 340, 300);
  label(image, 230, 115, 10);
  fill(image, 280, 150, 180, 235, GREY); // ← 狙いの写真 (枠線の中)
  fill(image, 600, 170, 250, 220, GREY);
  fill(image, 240, 420, 200, 260, GREY); // ← 2 段目 (枠線の 20 px 下)
  fill(image, 600, 420, 230, 260, GREY);
  return image;
}

/** p3 の紙面: ラベル / 破線 / [黄色の塗り + 細い輪郭] / 破線 / ラベル。右に写真。 */
function p3Like() {
  const image = canvas();
  label(image, 250, 60, 6);
  dashes(image, 300, 90, 40);
  fill(image, 220, 140, 210, 60, YELLOW); // 塗りの部分 (芯がある)
  frame(image, 220, 200, 210, 70, 2); // 白い部分の細い輪郭 (芯が無い)
  dashes(image, 280, 275, 40);
  label(image, 240, 330, 7);
  fill(image, 520, 150, 280, 150, GREY); // 右隣の写真
  fill(image, 240, 400, 180, 250, GREY); // 2 段目
  return image;
}

describe("snapBox", () => {
  it("⚠⚠ 下へ伸びた枠 (実測で高さ 1.7〜2.9 倍) は、上の段の図 1 つに縮む", () => {
    const image = p2Like();
    // モデルがよく返す形: 幅はだいたい合っていて、下の段まで入っている。
    const snapped = snapBox(image, seed(image, 190, 90, 420, 560));
    expect(pixels(image, snapped)).toEqual({
      left: 280 - PAD,
      top: 150 - PAD,
      right: 460 + PAD,
      bottom: 385 + PAD,
    });
  });

  it("⚠⚠ 図を囲む細い枠線とラベルは入れない (写真だけ)", () => {
    const image = p2Like();
    // 枠線ごとぴったり囲んだ種でも、枠線とラベルは図ではない。
    const snapped = pixels(image, snapBox(image, seed(image, 200, 100, 340, 300)));
    expect(snapped).toEqual({ left: 276, top: 146, right: 464, bottom: 389 });
  });

  it("⚠ 上が切れた枠 (実測で上端が 0.63、図は 0.615 から) は、図の上端まで広がる", () => {
    const image = p2Like();
    const snapped = pixels(image, snapBox(image, seed(image, 260, 300, 420, 300)));
    expect(snapped).toEqual({ left: 276, top: 146, right: 464, bottom: 389 });
  });

  it("⚠ 同じ段に並んだ図を 2 つ囲んだら、左の 1 つにする (「いちばん左上」の規則のまま)", () => {
    const image = p2Like();
    // 2 段目の 2 つを囲んだ種 → 2 段目の左 (1 段目は種と重なっていない)。
    const snapped = pixels(image, snapBox(image, seed(image, 230, 410, 620, 280)));
    expect(snapped).toEqual({ left: 236, top: 416, right: 444, bottom: 684 });
  });

  it("⚠⚠ 塗りと細い輪郭でできたイラストは、輪郭まで含めて 1 つ (ラベルは入れない)", () => {
    const image = p3Like();
    // モデルの枠: ラベルと右隣の写真まで入っている。
    const snapped = pixels(image, snapBox(image, seed(image, 230, 120, 450, 200)));
    expect(snapped).not.toBeNull();
    // 左右と上は図そのもの。下は輪郭の下端 (270) の先の破線がつながってよい (ラベルの手前まで)。
    expect(snapped!.left).toBe(220 - PAD);
    expect(snapped!.right).toBe(430 + PAD);
    expect(snapped!.top).toBe(140 - PAD);
    expect(snapped!.bottom).toBeGreaterThanOrEqual(270 + PAD);
    expect(snapped!.bottom).toBeLessThan(330);
  });

  it("⚠ 図が無い (罫線と文字だけ) なら null (呼び手はモデルの枠のまま切る)", () => {
    const image = canvas();
    frame(image, 100, 100, 800, 300);
    fill(image, 100, 200, 800, 3, BLACK);
    label(image, 150, 130, 20);
    label(image, 150, 250, 20);
    expect(snapBox(image, seed(image, 100, 100, 800, 300))).toBeNull();
  });

  it("⚠ 真っ白なら null", () => {
    const image = canvas();
    expect(snapBox(image, seed(image, 100, 100, 300, 300))).toBeNull();
  });

  it("⚠ 種の端をかすめただけの隣の図は選ばない", () => {
    const image = canvas();
    fill(image, 100, 100, 200, 200, GREY); // 種の左上をかすめる
    fill(image, 400, 100, 200, 200, GREY); // 種が指している図
    const snapped = pixels(image, snapBox(image, seed(image, 290, 90, 330, 230)));
    expect(snapped).toEqual({ left: 396, top: 96, right: 604, bottom: 304 });
  });

  it("⚠ 描いた dpi が違っても同じ意味で動く (px の値は幅に比例させている)", () => {
    // 150 dpi 相当 (幅 1240)。p2 と同じ形を半分の大きさで描く。
    const image = canvas(1240, 600);
    frame(image, 100, 50, 170, 160, 2);
    fill(image, 140, 75, 90, 118, GREY);
    fill(image, 120, 225, 100, 130, GREY);
    const snapped = pixels(image, snapBox(image, seed(image, 95, 45, 210, 280)));
    expect(snapped).toEqual({ left: 138, top: 73, right: 232, bottom: 195 });
  });
});
