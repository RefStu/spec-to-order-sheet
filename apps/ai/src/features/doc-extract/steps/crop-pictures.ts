import { createStep } from "@mastra/core/workflows";
import {
  docExtractResponseSchema,
  type DocExtractRequest,
  type DocExtractResponse,
  type ExtractedPicture,
  type PictureBox,
} from "../contract";
import { cropPicture, decodePage, PICTURE_MEDIA_TYPE } from "../lib/crop-picture";
import { CROP_DPI, renderPages, type RenderedPage } from "../lib/page-images";
import { countPages } from "../lib/pdf-pages";
import { emitProgress } from "../lib/progress";
import { dedupeBoxes, usableBox, type NormalizedBox, type PageShape } from "../lib/picture-box";
import { snapBox, type RgbaImage } from "../lib/snap-box";

export const cropPicturesStepId = "crop-pictures";

/**
 * 1 枚の依頼書から切り出す上限。
 *
 * ⚠ 実物の代表の図はせいぜい数枚。ここが緩いと、紙面の図を片端から指した実行で
 *   画面の `‹ 1/n ›` が何十枚にもなり、**人が捨てきれなくなる**。
 */
const MAX_PICTURES_PER_SHEET = 4;

/**
 * ノード④: 依頼書が指した**代表の図の枠を切り出す**。
 *
 * ⚠⚠ **モデルは呼ばない。** ここは読み取った座標をもとに絵を切るだけの処理で、
 *   workflow の step にしてあるのは**トレースで時間が見える**ようにするため。
 * ⚠ **切れなかったものは入れない。** 枠がおかしい・ページの絵が取れない・
 *   小さすぎる、のいずれでも黙って飛ばす。写真の欄は空のままが正しい (出どころの無い値を埋めない)。
 * ⚠⚠ **モデルが見たのと同じ「描画したページ」から切る。** 以前は PDF に埋まっている
 *   地の JPEG を抜いていたが、それはスキャンの MRC の**下の層**で、印字の層が写っていない。
 *   描画した絵から切れば、モデルが枠を指した絵とそのまま一致する。
 * ⚠ 代表の図は**ページの 1 % ほど**しかないので `CROP_DPI` (300) で描く。
 * ⚠ `pdftoppm` が `/Rotate` を当てるので、**回転はもう考えなくてよい**
 *   (`crop-picture.ts` から回す処理ごと消してある)。
 * ⚠ **どの依頼書のものかは添字で指す。** specNo で指すと、番号が読めなかった
 *   依頼書の写真が迷子になる。
 * ⚠⚠ **モデルの枠をそのまま切らない。** 枠を種にして、白地の上の白以外の塊
 *   (= 図 1 つ) に寄せてから切る (`lib/snap-box.ts`)。モデルは場所は当てるが大きさを
 *   当てられず、そのまま切ると隣の図やラベルが入る / 図が切れる。
 */
export const cropPicturesStep = createStep({
  id: cropPicturesStepId,
  description: "依頼書が指した代表の図の枠をページの絵から切り出す",
  inputSchema: docExtractResponseSchema,
  outputSchema: docExtractResponseSchema,
  /*
   * ⚠ ここはモデルを呼ばないので `tracingContext` / `mastra` を受けていない
   *   (子 span を作らないため)。**モデルを呼ぶように変えるときは必ず受けて
   *   `runExtraction` へ素通しすること** — 渡さないと `agent_run` が丸ごと消える
   *   (`lib/run-extraction.ts` の冒頭)。
   */
  execute: async ({ inputData, getInitData, writer }) => {
    const response = inputData;
    const node = { node: cropPicturesStepId, label: "代表の図を切り出す" };
    // ⚠ `writer` は進捗を流すだけ。**`tracingContext` は受けない** (上の注記のとおり)。
    await emitProgress(writer, { ...node, stage: "shape", status: "running" });
    try {
      // ⚠ PDF は step の入出力に載せず、workflow の入力から読む (`classify.ts` の注記)。
      const pictures = await croppedPictures(getInitData<DocExtractRequest>(), response);
      await emitProgress(writer, { ...node, stage: "shape", status: "succeeded" });
      return { ...response, extraction: { ...response.extraction, pictures } };
    } catch (error) {
      // ⚠ **失敗も流してから投げ直す。** 流さないと画面が回り続ける (`extract.ts` と同じ)。
      await emitProgress(writer, { ...node, stage: "shape", status: "failed" });
      throw error;
    }
  },
});

/**
 * 切り出しの本体。**切れなかったものは入れない** (空が正常)。
 *
 * ⚠⚠ **ここで早期に返しても「終わった」ことにする。** 以前はこの 3 つの分かれ道が
 *   `execute` の中で `return response` していて、**`succeeded` を流さないまま**抜けていた。
 *   枠が 1 つも無い PDF では画面の「整形中」が**終わらないまま**になる (実際にそうなっていた)。
 *   だから**出口は `execute` に 1 つだけ**にして、ここは値を返すだけにしてある。
 */
async function croppedPictures(
  request: DocExtractRequest,
  response: DocExtractResponse,
): Promise<ExtractedPicture[]> {
  /*
   * ⚠ 畳むのも上限も**依頼書ごと**。別の依頼書が同じ図を指すのは正しいことがある
   *   (1 ページに依頼書が 2 枚載る様式)ので、束ねてから畳まない。
   * ⚠⚠ `pictureIndex` は**枠の並び**で決める (切れたかどうかでは決めない)。切れなかった
   *   枠のぶんは番号が飛ぶが、それでよい。切れたものに 0 から振り直すと、前の実行と
   *   同じ図が違う鍵 (`photoStorageKey`) になり、同じバイト列の `files` 行が増える。
   */
  const boxes = response.extraction.specSheets.flatMap((sheet, specSheetIndex) =>
    dedupeBoxes(sheet.pictures)
      .slice(0, MAX_PICTURES_PER_SHEET)
      .map((box, pictureIndex) => ({ specSheetIndex, pictureIndex, box })),
  );
  if (boxes.length === 0) return [];

  const pdf = Buffer.from(request.dataBase64, "base64");
  const pageCount = countPages(pdf);
  if (pageCount === 0) return [];

  // ⚠ 範囲の外のページを描こうとすると落ちるので、先に捨てる (枠の検査は usableBox)。
  const wanted = [...new Set(boxes.map((entry) => entry.box.page))].filter(
    (pageNo) => Number.isInteger(pageNo) && pageNo >= 1 && pageNo <= pageCount,
  );
  if (wanted.length === 0) return [];

  // ページの絵は使い回す (1 ページに依頼書が複数載ることがある)。
  const byPage = new Map<number, RenderedPage>();
  for (const page of await renderPages(pdf, wanted, CROP_DPI)) byPage.set(page.pageNo, page);

  /*
   * ⚠ 展開した RGBA は**直前のページの 1 枚だけ**持つ。300 dpi の A4 は 1 枚約 35MB あり、
   *   全ページぶん持つと Cloud Run のメモリを食う。枠は依頼書の並び (= ページの並び) で
   *   来るので、ほとんどの場合 1 ページ 1 回の展開で済む。
   */
  let decoded: { pageNo: number; image: RgbaImage | null } | null = null;
  const imageOf = (page: RenderedPage): RgbaImage | null => {
    if (!decoded || decoded.pageNo !== page.pageNo) {
      decoded = { pageNo: page.pageNo, image: decodePage(page) };
    }
    return decoded.image;
  };

  const pictures: ExtractedPicture[] = [];
  for (const { specSheetIndex, pictureIndex, box } of boxes) {
    const page = byPage.get(box.page);
    if (!page) continue;

    // ⚠ 描いた絵は既に見たままの向きなので、幅と高さをそのまま渡す。
    const shape = { pageCount, pageWidth: page.width, pageHeight: page.height };
    const usable = usableBox(box, shape);
    if (!usable) continue;

    const image = imageOf(page);
    if (!image) continue;

    const target = snappedOrSeed(image, usable, box, shape);
    const cropped = cropPicture(image, target);
    if (!cropped) continue;

    pictures.push({
      specSheetIndex,
      pictureIndex,
      dataBase64: Buffer.from(cropped.jpeg).toString("base64"),
      mediaType: PICTURE_MEDIA_TYPE,
      // ⚠ **実際に切った枠**を載せる。モデルが答えた枠は `specSheets[].pictures` に残っている。
      box: { ...box, ...target },
    });
  }
  return pictures;
}

/**
 * モデルの枠を図 1 つに寄せる。寄せられなければ**モデルの枠のまま** (いままでの振る舞い)。
 *
 * ⚠⚠ **寄せた後の枠にも `usableBox` をかける** (面積・縦横比)。寄せた先が文字の欠片や
 *   ページの半分のような塊だったときに、それを切らないため。落ちたらモデルの枠に戻す。
 */
function snappedOrSeed(
  image: RgbaImage,
  usable: NormalizedBox,
  box: PictureBox,
  shape: PageShape,
): NormalizedBox {
  const snapped = snapBox(image, usable);
  if (!snapped) return usable;
  return usableBox({ ...box, ...snapped }, shape) ?? usable;
}
