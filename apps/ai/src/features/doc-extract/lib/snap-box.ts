import type { NormalizedBox } from "./picture-box";

/**
 * ★★ モデルが返した枠を「種」にして、**白地の上の白以外の塊 (= 図 1 つ)** に枠を寄せる。
 *
 * ⚠⚠ **なぜ要るか。** モデルは図の**場所**は当てるが、**大きさ**を当てられない
 *   (`prompts/picture-location.ts` の実測。文面を変えても、モデルを上げても直らなかった)。
 *   紙の地は白なので、枠の周りで「白以外の画素の塊」を探せば、図の端は**画素で**決まる。
 *   - 実測 (`openai/gpt-5`、実物のサンプル (非公開) を 3 回):
 *     モデルの枠は p2 で 293×414〜422×561 px (図 4 つを巻き込む / 上が切れる)、
 *     p3 で 322×245〜446×263 px (ラベルと隣の図が入る)。
 *     寄せた後は **6 個とも同じ枠**になった: p2 は 177×235 px (枠線の中の写真だけ)、
 *     p3 は 209×130 px (完成イメージのイラストだけ)。
 *
 * ⚠⚠ **縦横比が崩れて見えた原因もここで消える。** xlsx (`noChangeAspect`) も画面
 *   (`object-contain`) も比率を保っていて、崩れていたのは**モデルの枠の形そのもの**。
 *   モデルは割合 (0..1) で答えるので、`w = h` の「正方形」は A4 の画素では
 *   **1 : 1.41 の縦長**になる (実測: 0.118 × 0.118 → 293 × 414 px)。
 *   寄せた枠は**図の画素**から決まるので、紙の図と同じ比率になる。
 *
 * ⚠ **純粋な関数。** 入力はデコード済みの RGBA (`crop-picture.ts` の `decodePage()`)。
 *   依存は足さない (jpeg-js で足りる)。
 * ⚠ **寄せられなければ null。** 呼び手はモデルの枠のまま切る (いままでと同じ振る舞い)。
 * ⚠⚠ **「いちばん左上の 1 つ」を選ぶ規則は変えない**。
 *   ここは種に重なる塊のうち**いちばん上の段の左端**を取るだけで、種が指している図を
 *   別の図に取り替えるためのものではない。
 */

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * 下の px の値は **300 dpi (`CROP_DPI`) の A4 = 幅 2480 px** を 1 とした値。
 * 描いた幅に比例させるので、dpi を変えても意味は変わらない。
 */
const REFERENCE_WIDTH = 2480;

/**
 * RGB の最小値がこれより暗ければ「白以外」。
 *
 * ⚠⚠ **実測で 200〜230 の間なら結果が変わらない。** 外すと壊れ方がはっきりしている:
 *   - 180: p3 のイラストの**白い部分の輪郭**を落とし、黄色の半分だけになる
 *   - 240: 紙の地のざらつきが写真と枠線をつなぎ、**枠線 (とラベル) ごと**囲む
 * ⚠ 彩度では判定しない。最大が 255 なので、最小が 215 以上なら差は 40 以下にしかならない
 *   (淡い色も最小値で拾える。実測で彩度の閾値を振っても結果は同じだった)。
 */
export const INK_MAX = 215;
/**
 * 塊をつなぐ距離。写真の中の白飛びで 1 枚が割れないように、この距離までの隙間は埋める。
 *
 * ⚠⚠ **上げすぎると隣とつながる。** 実測で 1〜3 は同じ結果、6 で p2 の写真が**外の枠線**と、
 *   9 で p3 のイラストが**隣の写真**とつながった (紙の上の図の間隔は 20 px ほどしかない)。
 */
export const BRIDGE_PX = 3;
/**
 * 「図」とみなすには、**一辺 (2r+1) px の正方形がすべて白以外**の場所 (芯) が要る。
 *
 * ⚠⚠ **罫線・枠線・文字を拾わないための仕組みはこれ。** 線や文字の画数は細いので芯を持たず、
 *   写真や塗りのあるイラストだけが芯を持つ。実測で r = 1 だと p2 の**枠線 (約 3 px)** が芯を持ち、
 *   ラベルごと囲んだ枠を選んだ。3〜6 は同じ結果。
 * ⚠ 芯で決めるのは「図かどうか」だけで、**枠は塊全体で取る**。だから p3 の白い部分の
 *   細い輪郭も落ちない (芯の無い輪郭を捨てると、イラストの半分が切れる)。
 */
export const CORE_RADIUS_PX = 3;
/** 芯の画素がこれより少ない塊は図とみなさない (太い文字の点や印の欠片)。 */
const MIN_CORE_PIXELS = 400;
/** 幅か高さがこれより小さい塊は図とみなさない (約 3.4 mm)。 */
const MIN_SIDE_PX = 40;
/**
 * 種の外をどこまで探すか (種の長いほうの辺に対する割合)。
 *
 * ⚠ 種が図の**上を切っている**ことがある (実測: 上端が 0.63 で、図は 0.615 から)。
 *   種の中だけを見ると、図の切れた残りしか取れない。
 */
const SEARCH_MARGIN = 0.5;
/**
 * 種と重なっているとみなす割合 (塊と種の小さいほうの面積に対して)。
 *
 * ⚠ 種の端をかすめただけの塊 (隣の図の縁) は候補にしない。
 */
const MIN_OVERLAP = 0.25;
/** 寄せた枠の外に足す余白。縁のにじみを切らないため。 */
const PAD_PX = 4;

interface Rect {
  left: number;
  top: number;
  /** 含まない (right - left が幅)。 */
  right: number;
  bottom: number;
}

interface Blob extends Rect {
  /** 芯の画素の数。 */
  core: number;
}

function area(rect: Rect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

function overlap(a: Rect, b: Rect): number {
  return area({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
}

/** 範囲の中の「白以外」を 1 にした配列 (幅 × 高さ)。 */
function inkMask(image: RgbaImage, region: Rect): Uint8Array {
  const width = region.right - region.left;
  const height = region.bottom - region.top;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let at = ((region.top + y) * image.width + region.left) * 4;
    for (let x = 0; x < width; x++, at += 4) {
      const min = Math.min(image.data[at]!, image.data[at + 1]!, image.data[at + 2]!);
      if (min < INK_MAX) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** 累積和 ((w+1) × (h+1))。矩形の中の画素数を O(1) で数えるため。 */
function integral(mask: Uint8Array, width: number, height: number): Int32Array {
  const stride = width + 1;
  const sum = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += mask[y * width + x]!;
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1]! + row;
    }
  }
  return sum;
}

/** [x0, x1) × [y0, y1) の中の画素数。 */
function countIn(sum: Int32Array, width: number, x0: number, y0: number, x1: number, y1: number) {
  const stride = width + 1;
  return (
    sum[y1 * stride + x1]! - sum[y0 * stride + x1]! - sum[y1 * stride + x0]! + sum[y0 * stride + x0]!
  );
}

function root(parent: Int32Array, index: number): number {
  let at = index;
  while (parent[at] !== at) {
    parent[at] = parent[parent[at]!]!;
    at = parent[at]!;
  }
  return at;
}

/**
 * 塊に分ける。つなぐのは `bridge` px 広げた絵、**枠と芯を数えるのは元の絵**。
 * ⚠ 広げた絵で枠を取ると、図の周りが `bridge` px ずつ太る。
 */
function blobsOf(
  mask: Uint8Array,
  width: number,
  height: number,
  bridge: number,
  coreRadius: number,
): Blob[] {
  const sum = integral(mask, width, height);
  const joined = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - bridge);
    const y1 = Math.min(height, y + bridge + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - bridge);
      const x1 = Math.min(width, x + bridge + 1);
      if (countIn(sum, width, x0, y0, x1, y1) > 0) joined[y * width + x] = 1;
    }
  }

  // 8 近傍の union-find。
  const parent = new Int32Array(width * height).fill(-1);
  const join = (a: number, b: number) => {
    const ra = root(parent, a);
    const rb = root(parent, b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!joined[at]) continue;
      parent[at] = at;
      if (x > 0 && parent[at - 1]! >= 0) join(at, at - 1);
      if (y === 0) continue;
      if (parent[at - width]! >= 0) join(at, at - width);
      if (x > 0 && parent[at - width - 1]! >= 0) join(at, at - width - 1);
      if (x < width - 1 && parent[at - width + 1]! >= 0) join(at, at - width + 1);
    }
  }

  const full = (2 * coreRadius + 1) ** 2;
  const blobs = new Map<number, Blob>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!mask[at]) continue;
      const key = root(parent, at);
      let blob = blobs.get(key);
      if (!blob) {
        blob = { left: x, top: y, right: x + 1, bottom: y + 1, core: 0 };
        blobs.set(key, blob);
      }
      blob.left = Math.min(blob.left, x);
      blob.right = Math.max(blob.right, x + 1);
      blob.top = Math.min(blob.top, y);
      blob.bottom = Math.max(blob.bottom, y + 1);
      const isCore =
        x >= coreRadius &&
        y >= coreRadius &&
        x + coreRadius < width &&
        y + coreRadius < height &&
        countIn(sum, width, x - coreRadius, y - coreRadius, x + coreRadius + 1, y + coreRadius + 1) ===
          full;
      if (isCore) blob.core++;
    }
  }
  return [...blobs.values()];
}

/**
 * 枠を図 1 つに寄せる。寄せられなければ null。
 *
 * 手順:
 * 1. 種を `SEARCH_MARGIN` だけ広げた範囲で、白以外の画素を `BRIDGE_PX` でつないで塊に分ける
 * 2. 芯 (`CORE_RADIUS_PX`) を持たない塊 (罫線・枠線・文字・破線) を捨てる
 * 3. 種と `MIN_OVERLAP` 以上重なる塊のうち、**いちばん上の段の左端**を選ぶ
 *    (種は下へ伸びて次の段の図まで入っていることが多い。実測で高さが 1.7〜2.9 倍)
 * 4. その塊の外接矩形に `PAD_PX` を足す
 *
 * ⚠ 戻りは**ページに対する割合**。使ってよいかの検査 (`usableBox`) は呼び手がかける。
 *
 * @param image 描いたページ (**見たままの向き**)。
 * @param seed モデルの枠 (`usableBox` を通したもの)。
 */
export function snapBox(image: RgbaImage, seed: NormalizedBox): NormalizedBox | null {
  const unit = image.width / REFERENCE_WIDTH;
  const px = (value: number) => Math.max(1, Math.round(value * unit));

  const seedRect: Rect = {
    left: Math.round(seed.x * image.width),
    top: Math.round(seed.y * image.height),
    right: Math.round((seed.x + seed.width) * image.width),
    bottom: Math.round((seed.y + seed.height) * image.height),
  };
  const margin = Math.round(
    SEARCH_MARGIN * Math.max(seedRect.right - seedRect.left, seedRect.bottom - seedRect.top),
  );
  const region: Rect = {
    left: Math.max(0, seedRect.left - margin),
    top: Math.max(0, seedRect.top - margin),
    right: Math.min(image.width, seedRect.right + margin),
    bottom: Math.min(image.height, seedRect.bottom + margin),
  };
  const width = region.right - region.left;
  const height = region.bottom - region.top;
  if (width <= 0 || height <= 0 || area(seedRect) <= 0) return null;

  const minCore = MIN_CORE_PIXELS * unit * unit;
  const minSide = px(MIN_SIDE_PX);
  const seedArea = area(seedRect);
  const figures = blobsOf(inkMask(image, region), width, height, px(BRIDGE_PX), px(CORE_RADIUS_PX))
    .map((blob) => ({
      ...blob,
      left: blob.left + region.left,
      right: blob.right + region.left,
      top: blob.top + region.top,
      bottom: blob.bottom + region.top,
    }))
    .filter(
      (blob) =>
        blob.core >= minCore &&
        blob.right - blob.left >= minSide &&
        blob.bottom - blob.top >= minSide &&
        overlap(blob, seedRect) >= MIN_OVERLAP * Math.min(area(blob), seedArea),
    );
  if (figures.length === 0) return null;

  // いちばん上の段 = いちばん上の塊の上端から、その塊の高さの半分までに上端がある塊。
  const top = figures.reduce((best, blob) => (blob.top < best.top ? blob : best));
  const rowLimit = top.top + (top.bottom - top.top) / 2;
  const chosen = figures
    .filter((blob) => blob.top < rowLimit)
    .reduce((best, blob) => (blob.left < best.left ? blob : best));

  const pad = px(PAD_PX);
  const left = Math.max(0, chosen.left - pad);
  const upper = Math.max(0, chosen.top - pad);
  const right = Math.min(image.width, chosen.right + pad);
  const bottom = Math.min(image.height, chosen.bottom + pad);
  return {
    x: left / image.width,
    y: upper / image.height,
    width: (right - left) / image.width,
    height: (bottom - upper) / image.height,
  };
}
