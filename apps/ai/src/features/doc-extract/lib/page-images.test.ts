import { encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import {
  CLASSIFY_DPI,
  CROP_DPI,
  DETAIL_DPI,
  EXTRACT_DPI,
  detailCropBox,
  jpegSize,
  renderArgs,
  ZOOM_DPI,
  zoomBands,
} from "./page-images";

/**
 * ⚠ **`pdftoppm` は呼ばない。** 二進と実物の PDF に依存させると、テストが開発機の
 *   都合で落ちるようになる。ここで固定するのは**引数の組み立て**と**寸法の読み取り**だけ。
 *   本物を通すのは `make dev` での通し確認。
 */

describe("renderArgs", () => {
  it("そのページ 1 枚だけを JPEG で stdout に出す", () => {
    expect(renderArgs(2, 200)).toEqual([
      "-jpeg",
      "-jpegopt",
      "quality=90",
      "-r",
      "200",
      "-f",
      "2",
      "-l",
      "2",
      "-singlefile",
      "-",
    ]);
  });

  /**
   * ⚠⚠ **`-singlefile` を外さないこと。** 外すと出力名に連番が付き、
   *   stdout に出なくなる (静かに 0 バイトになる)。
   * ⚠ 最後の `-` は「PDF を stdin から読む」。一時ファイルを作らないための肝。
   */
  it("⚠ -singlefile と stdin の - を落とさない", () => {
    const args = renderArgs(1, 100);
    expect(args).toContain("-singlefile");
    expect(args.at(-1)).toBe("-");
  });

  it("-f と -l を同じページにする (1 回で 1 枚)", () => {
    const args = renderArgs(3, 300);
    expect(args[args.indexOf("-f") + 1]).toBe("3");
    expect(args[args.indexOf("-l") + 1]).toBe("3");
  });
});

/**
 * ⚠ 解像度はノードごとに違う。**分類を上げても良くならない** (表題と紙の形しか見ない) し、
 *   代表の図はページの 1 % ほどなので切り出しだけ高く取る。
 */
describe("解像度", () => {
  it("分類 < 読み取り < 切り出し", () => {
    expect(CLASSIFY_DPI).toBeLessThan(EXTRACT_DPI);
    expect(EXTRACT_DPI).toBeLessThan(CROP_DPI);
  });

  it("⚠ 読み取りは 200 dpi 以上 (これ未満だと小さい印字が読めないと実測済み)", () => {
    expect(EXTRACT_DPI).toBeGreaterThanOrEqual(200);
  });
});

describe("jpegSize", () => {
  const jpegOf = (width: number, height: number) =>
    new Uint8Array(
      encode({ data: new Uint8Array(width * height * 4).fill(200), width, height }, 80).data,
    );

  it("本物の JPEG から幅と高さを読む", () => {
    expect(jpegSize(jpegOf(32, 48))).toEqual({ width: 32, height: 48 });
  });

  it("横長でも縦横を取り違えない", () => {
    expect(jpegSize(jpegOf(64, 16))).toEqual({ width: 64, height: 16 });
  });

  it("⚠ JPEG でなければ null (呼び手が落とす)", () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(new Uint8Array())).toBeNull();
  });

  it("⚠ 途中で切れた JPEG も null (壊れた絵を切りに行かない)", () => {
    expect(jpegSize(jpegOf(32, 48).slice(0, 8))).toBeNull();
  });
});

/**
 * ★★ ページを横帯に割って拡大する。
 *
 * ⚠⚠ **dpi を上げても解像度は上がらない** (200 dpi と 300 dpi で入力トークンが同じ ＝
 *   プロバイダ側が一定の大きさまで縮める)。**紙を割ると 1 枚あたりの縮小率が下がる。**
 */
describe("zoomBands", () => {
  it("1 枚以下なら割らない (割る意味が無い)", () => {
    expect(zoomBands(0)).toEqual([]);
    expect(zoomBands(1)).toEqual([]);
  });

  it("枚数ぶんの帯になり、上から下までを覆う", () => {
    const bands = zoomBands(2);
    expect(bands).toHaveLength(2);
    expect(bands[0]!.top).toBe(0);
    expect(bands.at(-1)!.bottom).toBe(1);
  });

  /** ⚠ 境目に載った行がどちらからも切れないよう、帯どうしを重ねる。 */
  it("⚠ 隣の帯と重なる (境目の行を落とさない)", () => {
    const [first, second] = zoomBands(2);
    expect(first!.bottom).toBeGreaterThan(second!.top);
  });

  it("⚠ ページの外へはみ出さない", () => {
    for (const band of zoomBands(3)) {
      expect(band.top).toBeGreaterThanOrEqual(0);
      expect(band.bottom).toBeLessThanOrEqual(1);
      expect(band.bottom).toBeGreaterThan(band.top);
    }
  });
});

/**
 * ⚠⚠ 細部の拡大。帯は幅で縮小の上限に当たるので、**幅を狭くして**画素を増やす。
 */
describe("detailCropBox", () => {
  it("割合をその dpi のピクセルにする", () => {
    const box = detailCropBox({ top: 0.88, bottom: 1, left: 0, right: 0.6, label: "x" }, 4960, 7016);
    expect(box).toEqual({ x: 0, y: 6174, width: 2976, height: 842 });
  });

  it("右側の切り出しはページの右端で終わる (はみ出さない)", () => {
    const box = detailCropBox({ top: 0.88, bottom: 1, left: 0.4, right: 1, label: "x" }, 4960, 7016);
    expect(box.x + box.width).toBe(4960);
    expect(box.y + box.height).toBe(7016);
  });

  /**
   * ⚠⚠ **dpi を上げて効くのは幅が狭いときだけ。** ページ全体・帯 (`ZOOM_DPI`) より高くないと
   *   足す意味が無い。
   */
  it("⚠ 帯より高い解像度で描く", () => {
    expect(DETAIL_DPI).toBeGreaterThan(ZOOM_DPI);
  });
});

describe("renderArgs — 切り出し", () => {
  it("範囲を渡すと -x -y -W -H が付く", () => {
    const args = renderArgs(2, 300, { x: 0, y: 100, width: 2480, height: 900 });
    expect(args[args.indexOf("-x") + 1]).toBe("0");
    expect(args[args.indexOf("-y") + 1]).toBe("100");
    expect(args[args.indexOf("-W") + 1]).toBe("2480");
    expect(args[args.indexOf("-H") + 1]).toBe("900");
    // ⚠ 切り出しても stdout に出す (-singlefile と - は残る)。
    expect(args).toContain("-singlefile");
    expect(args.at(-1)).toBe("-");
  });

  it("範囲を渡さなければ付かない (ページ全体)", () => {
    expect(renderArgs(2, 200)).not.toContain("-x");
  });
});
