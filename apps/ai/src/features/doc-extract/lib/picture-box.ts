import type { PictureBox } from "../contract";

/**
 * モデルが返した「代表の図の場所」を**使ってよいか決める**。
 *
 * ⚠⚠ **モデルの座標をそのまま信じない。** 外れた枠で切ると、関係のない切れ端が
 *   写真の欄に入ってしまう。**おかしければ切らない**(欄は空のまま) のが正しい。
 * ⚠ 契約 (`contract.ts` の `pictureBox`) はわざと数の範囲を縛っていない。
 *   zod で落とすと**読み取りごと失敗する**ので、判断はここでする。
 */

/** ページに対する割合の枠 (0..1)。 */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ページのどれくらいを占めていたら「図」として妥当か。
 *
 * ⚠⚠ **実物で測った値が根拠。** 依頼書の代表の図は
 *   **ページ全体の 0.6 % 〜 1.5 %** しかない (A4 の下のほうに並ぶ図の 1 つ)。
 *   上限が緩いと「ページの下半分ごと (≒ 50 %)」のような枠が通ってしまい、
 *   メッキ指示の図まで写真の欄に入る。**上限は実物の 5 倍ほどに締めてある。**
 * ⚠ 下限は実物 (0.6 %) の 3 分の 1。ここを上げると本物の代表の図を捨てる。
 * ⚠ **広すぎる枠は切らない (欄は空) のが正しい。** 関係のない切れ端より空のほうがよい。
 */
/**
 * ⚠ 下限。**下げていない**（実測で 0.0048 / 0.0080 だったので余裕がある）。
 *   下げるとラベルの文字や罫線の切れ端まで通るようになる。
 */
export const MIN_AREA_RATIO = 0.002;
export const MAX_AREA_RATIO = 0.08;
/** 縦横比がこれより極端なら、線や帯を指している。 */
export const MAX_ASPECT = 8;
/**
 * ⚠⚠ **いまは confidence で落とさない。**
 *
 *   もとは 70 で、「自信が無い枠では切らない (空のほうが正しい)」という考えだった。
 *   実測でその前提が崩れたので、**「外れが混じっても、とりあえず出す」に振った**。
 *
 *   - 枠 57 個のうち 70 以上は 4 個だけ、**70 を超えた枠は 1 つも無かった** (分布 48〜70)。
 *   - 実物から切り出して目で見ると、**confidence は当たり外れを分けていない**。
 *     同じ 1 通の中で、依頼書 A は 60 / 68 / 70 がどれも命中し、
 *     依頼書 B は 55 / 60 / 62 / 68 のすべてが外れた (B はラベルが横に 2 つ並んでいて、
 *     モデルが**右隣の【刻印位置】の写真**を指す)。
 *
 *   ⚠ **誤った切れ端が写真の欄に入る。** 人が画面で見て捨てる前提。
 *   ⚠ **戻すのは 1 行。** 空のほうがよいと判断したら、ここを 70 に戻せば元の振る舞いになる。
 *   ⚠⚠ **範囲・面積・縦横比の検査は外さないこと。** ページの下半分ごとを指すような枠
 *     (実測で面積 0.28 の枠があった) は、ここではなく `MAX_AREA_RATIO` が止めている。
 *   ⚠ 当たりを本当に上げるなら閾値ではない。**「使ったラベルの語と、その位置」を
 *     契約で答えさせて突き合わせる**ほうに手がある。
 */
export const MIN_BOX_CONFIDENCE = 0;
/** はみ出しをどこまで許すか (ぴったり 1.0 を狙って少し超える程度は直す)。 */
const SLACK = 0.05;

export interface PageShape {
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
}

function finite(...values: number[]): boolean {
  return values.every((v) => typeof v === "number" && Number.isFinite(v));
}

/**
 * 使える枠なら 0..1 に収めたものを、使えなければ null を返す。
 *
 * ⚠ 戻りの枠は**ページの見た目の向き**のまま (画像の向きへ直すのは `boxToImageSpace`)。
 */
export function usableBox(box: PictureBox, shape: PageShape): NormalizedBox | null {
  if (!Number.isInteger(box.page) || box.page < 1 || box.page > shape.pageCount) return null;
  if (!Number.isFinite(box.confidence) || box.confidence < MIN_BOX_CONFIDENCE) return null;
  if (!finite(box.x, box.y, box.width, box.height)) return null;
  if (box.width <= 0 || box.height <= 0) return null;

  // 大きく外れているものは「直す」のではなく捨てる (当てずっぽうの可能性が高い)。
  if (box.x < -SLACK || box.y < -SLACK) return null;
  if (box.x + box.width > 1 + SLACK || box.y + box.height > 1 + SLACK) return null;

  const x = Math.min(Math.max(box.x, 0), 1);
  const y = Math.min(Math.max(box.y, 0), 1);
  const width = Math.min(box.width, 1 - x);
  const height = Math.min(box.height, 1 - y);
  if (width <= 0 || height <= 0) return null;

  const area = width * height;
  if (area < MIN_AREA_RATIO || area > MAX_AREA_RATIO) return null;

  // 縦横比は**ピクセルで**見る (割合のままだと用紙の縦長ぶんだけ歪む)。
  const pixelWidth = width * shape.pageWidth;
  const pixelHeight = height * shape.pageHeight;
  const aspect = Math.max(pixelWidth / pixelHeight, pixelHeight / pixelWidth);
  if (aspect > MAX_ASPECT) return null;

  return { x, y, width, height };
}

/**
 * ⚠ **同じ図を 2 回指した枠を畳む。**
 *
 * ⚠⚠ **1 枚の依頼書から枠を複数受け取るようになって初めて要る検査。**
 *   1 つだったころは構造的に起きなかったが、複数を許した瞬間に
 *   「同じ図を 2 回挙げる」実行が出る (そのまま切ると同じ絵が 2 枚欄に並ぶ)。
 * ⚠ **IoU にしない。** 閾値がもう 1 つ増えるうえ、その値に実測の根拠が無い。
 *   モデルが出すのは「似た枠」ではなく**ほぼ同じ座標**なので、
 *   **3 桁に丸めた鍵**で足りる (1240px 幅なら 1px ほどの粒度)。
 * ⚠ **先に出たほうを残す** (モデルが挙げた順 = 紙の上から順であることが多い)。
 * ⚠ ここは「重複か」だけを見る。使ってよいかの判断は `usableBox()` のまま。
 */
export function dedupeBoxes(boxes: readonly PictureBox[]): PictureBox[] {
  const seen = new Set<string>();
  const kept: PictureBox[] = [];
  for (const box of boxes) {
    // ⚠ 数でない値は丸められないので、鍵を作らずそのまま残す (捨てるのは usableBox の仕事)。
    if (!finite(box.x, box.y, box.width, box.height)) {
      kept.push(box);
      continue;
    }
    const key = [
      box.page,
      box.x.toFixed(3),
      box.y.toFixed(3),
      box.width.toFixed(3),
      box.height.toFixed(3),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(box);
  }
  return kept;
}
