import { execFile } from "node:child_process";
import type { DocExtractRequest } from "../contract";

/**
 * ★★ PDF の**ページを画像にしてからモデルに渡す**ための部品。
 *
 * ⚠⚠ **なぜ要るか。** 実物はスキャンした帳票で、PDF をそのまま渡すと**小さい印字が読めない**。
 *   同じモデル・同じページで実測した: PDF をそのまま渡すと発注No は null、
 *   **200 dpi の画像にすると正しく読めた**。落ちていたのは資材名・発注No・石種・
 *   丸囲みの区分といった**小さい印字だけ**で、大きい印字は全部読めていた。
 * ⚠⚠ **ページを選んで渡せるようになる。** 以前は 4 回とも PDF 全体 (3 ページ) を送り、
 *   「n ページ目だけ読んで」と**言葉で**指示していた (入力が 3 倍。しかも隣のページが
 *   見えているせいで「1 枚目の石を 2 枚目に写す」でっち上げが実際に起きた)。
 *
 * ⚠ **ネイティブ拡張ではない。** 避けるべきなのは `mastra build` の成果物
 *   (`.mastra/output` だけを持っていく) に残らないネイティブ拡張で、
 *   **OS の二進を subprocess で呼ぶのはその罠に当たらない**。
 *   - ローカル: `flake.nix` の `poppler-utils` (devShell)
 *   - コンテナ: `apps/ai/Dockerfile` の実行段で `apt-get install poppler-utils`
 *   **どちらかが欠けたら黙って劣化させず、名指しで落とす** (`missingBinaryError`)。
 * ⚠ ここは `apps/ai` なので `node:` を使ってよい (禁止は `apps/web/src` だけ)。
 */

/** 分類は表題と紙の形しか見ない。**小さい印字を読まないので低くてよい。** */
export const CLASSIFY_DPI = 100;
/**
 * 読み取り。
 *
 * ⚠⚠ **上げても良くならない。実測で確かめた。** 200 dpi と 300 dpi で
 *   **入力トークンが 15,504 でまったく同じ**だった ＝ プロバイダ側が画像を一定の
 *   大きさまで縮めている。読めた欄も同じで、300 dpi のほうは依頼書の番号を
 *   突き合わせに使えない形 (`2099 — 05 — S001`) で返し、代表の図では
 *   **別の図を指した**。**上げる意味は無い。**
 * ⚠ 下げるのは駄目。PDF をそのまま渡していたころは発注No が null で、
 *   200 dpi にして初めて読めた。
 * ⚠ ここから先の伸びしろは解像度ではなく「**ページを部品に割って渡す**」ほう
 *   (1 枚あたりの縮小率が下がるので、小さい印字に使える画素が増える)。
 */
export const EXTRACT_DPI = 200;
/** 代表の図の切り出し。**ページの 1 % ほどしかない**ので高めに取る。 */
export const CROP_DPI = 300;

/**
 * ★★ **同じページの一部を拡大した画像**の解像度と枚数。
 *
 * ⚠⚠ **なぜ要るか。** 200 dpi と 300 dpi で入力トークンが**まったく同じ**だった ＝
 *   プロバイダ側が画像を一定の大きさまで縮めるので、**A4 を 1 枚まるごと渡すかぎり
 *   dpi を上げても解像度は上がらない**。実測で、細い手書きの丸で選ばれた区分や
 *   細かい印字の資材名が読めなかった。
 *   → **紙を割って渡すと、1 枚あたりの縮小率が下がる** (同じ縮小先に半分の面積が入る)。
 * ⚠ 割るのは**横帯**だけ。表を左右に割ると行と列の対応が壊れる (1 つの表は 1 回で読む)。
 * ⚠ 帯どうしを少し重ねる。境目に載った行が**どちらからも切れる**のを防ぐ。
 */
export const ZOOM_DPI = 300;
const ZOOM_OVERLAP = 0.08;

/**
 * ⚠ **JPEG で出す。** 元がスキャンした JPEG なので画質の損は小さく、
 *   切り出し (`crop-picture.ts`) が既にある `jpeg-js` だけで完結する
 *   (PNG にすると PNG のデコーダを 1 つ増やすことになる)。
 */
export const PAGE_MEDIA_TYPE = "image/jpeg";
const JPEG_QUALITY = 90;

/** 1 ページぶんの JPEG は数 MB。既定の 1MB では足りない。 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const PDF_MEDIA_TYPE = "application/pdf";

export interface RenderedPage {
  /** PDF 全体の通し番号 (1 始まり)。 */
  pageNo: number;
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** モデルに渡す 1 枚。 */
export interface ExtractionImage {
  pageNo: number;
  /** base64 (data URL の接頭辞は付けない)。 */
  dataBase64: string;
  mediaType: string;
  /** **同じページを拡大した 1 枚**か (ページ全体なら false)。 */
  zoomed: boolean;
  /**
   * 拡大した帯が**ページの上から何番目か** (1 始まり)。ページ全体なら null。
   *
   * ⚠⚠ **これを伝えないと、モデルは帯の並びから位置を推測できない。** 実測で、
   *   「表題のすぐ下の行」を探すように言っても**紙の中ほどにある別の選択肢の行**を
   *   読んでしまう実行があった。帯に位置の名前を付けると、探す場所を絞れる。
   */
  band: { index: number; total: number } | null;
  /**
   * 帯とは別に、**紙の一部だけを細かく拡大した 1 枚**なら、その場所の言葉
   * (「紙のいちばん下の左側」など)。帯やページ全体なら無い。
   *
   * ⚠ `pageLabels()` がこの言葉をそのままモデルに伝える (位置を知らせないと、
   *   帯と同じく「別の紙」や「紙の中ほど」と取り違える)。
   */
  detail?: string;
}

/**
 * ★ 帯とは別に、紙の**一部だけ**を高い解像度で切り出す範囲 (割合)。
 *
 * ⚠⚠ **なぜ要るか。** 帯 6 本の時点で、プロバイダの縮小は**ページの幅**で上限に当たっている
 *   (帯を増やしても渡る画素は増えない)。**幅を狭くして初めて**画素が増える。
 *   実測 (`openai/gpt-5`): 紙の下のメモのタイ文字は、帯 6 本では `ญบ` などと読み違え、
 *   下 12 % を横 60 % で切った 600 dpi の 1 枚を足すと 3 回とも正しく読めた。
 * ⚠ **帯の代わりではなく、帯に足す。** 範囲の外に文字がはみ出していても、帯とページ全体で見える。
 * ⚠ 横にも割るので、**左右の境目に載った文字が切れない**よう、使う側で範囲を重ねること。
 */
export interface DetailCrop {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** モデルに伝える場所の言葉 (`ExtractionImage.detail`)。 */
  label: string;
}

/**
 * `DetailCrop` を描く解像度。
 *
 * ⚠⚠ **ページ全体や帯では dpi を上げても効かない** (`EXTRACT_DPI` の注記) が、ここは**幅が狭い**ので
 *   効く。縮小の上限は幅 2048 px ほどなので、紙の幅の 60 % を切るなら **約 413 dpi 相当**までは
 *   画素がそのまま届く (帯は約 248 dpi 相当)。600 は実測に使った値で、上限を超えたぶんは
 *   プロバイダが縮めるだけ (損は転送の大きさだけ)。⚠ **下げるなら実測をやり直す。**
 */
export const DETAIL_DPI = 600;

/**
 * `pdftoppm` に渡す引数。**純粋**なのでここをテストで固定する。
 *
 * ⚠ **PDF は stdin、画像は stdout。** 一時ファイルを作らない
 *   (Cloud Run の /tmp はメモリなので、置かずに済むなら置かない)。
 *   poppler 22.12 (Debian) と 26.06 (nix) の**両方で同じバイト列**になることを確かめてある。
 * ⚠ `-singlefile` が無いと出力名に連番が付き、stdout に出なくなる。
 * ⚠ **`/Rotate` は pdftoppm が当てる。** 出てくる絵は「人が見たままの向き」で、
 *   1 ページ目 (`/Rotate 270` の横向きの帳票) は横長のまま出る。
 */
export function renderArgs(pageNo: number, dpi: number, crop?: CropBox): string[] {
  return [
    "-jpeg",
    "-jpegopt",
    `quality=${JPEG_QUALITY}`,
    "-r",
    String(dpi),
    "-f",
    String(pageNo),
    "-l",
    String(pageNo),
    ...(crop
      ? [
          "-x",
          String(crop.x),
          "-y",
          String(crop.y),
          "-W",
          String(crop.width),
          "-H",
          String(crop.height),
        ]
      : []),
    "-singlefile",
    "-",
  ];
}

/** 切り出す範囲 (ピクセル。`pdftoppm` の -x -y -W -H)。 */
export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ページを**横帯**に割る (割合)。帯どうしは少し重ねる。
 *
 * ⚠ 1 枚だけのときは割らない (割る意味が無い)。
 */
export function zoomBands(count: number): { top: number; bottom: number }[] {
  if (count < 2) return [];
  const height = 1 / count;
  return Array.from({ length: count }, (_unused, index) => ({
    top: Math.max(0, index * height - ZOOM_OVERLAP),
    bottom: Math.min(1, (index + 1) * height + ZOOM_OVERLAP),
  }));
}

/**
 * `DetailCrop` を `pdftoppm` の切り出し (ピクセル) にする。**純粋**なのでここをテストで固定する。
 *
 * @param width `dpi` で描いたときのページの幅 (ピクセル)
 * @param height 同じく高さ
 */
export function detailCropBox(crop: DetailCrop, width: number, height: number): CropBox {
  const x = Math.round(crop.left * width);
  const y = Math.round(crop.top * height);
  return {
    x,
    y,
    width: Math.max(1, Math.round(crop.right * width) - x),
    height: Math.max(1, Math.round(crop.bottom * height) - y),
  };
}

/**
 * JPEG のヘッダ (SOFn マーカー) から幅と高さを読む。
 *
 * ⚠ **全部デコードしない。** 寸法しか要らないのに RGBA に展開すると、
 *   200 dpi の A4 で 15MB ほどを無駄に確保することになる。
 */
export function jpegSize(jpeg: Uint8Array): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;

  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = jpeg[at + 1]!;
    // SOF0..SOF15。⚠ DHT(c4) / JPG(c8) / DAC(cc) は寸法を持たないので外す。
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: (jpeg[at + 5]! << 8) | jpeg[at + 6]!,
        width: (jpeg[at + 7]! << 8) | jpeg[at + 8]!,
      };
    }
    // それ以外のセグメントは長さぶん飛ばす。
    const length = (jpeg[at + 2]! << 8) | jpeg[at + 3]!;
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function missingBinaryError(): Error {
  return new Error(
    "pdftoppm が見つかりません。ページを画像にできないので読み取りを止めました。\n" +
      "  ローカル: flake.nix の poppler-utils (make 経由なら devShell に入っています)\n" +
      "  コンテナ: apps/ai/Dockerfile の実行段の apt-get install poppler-utils",
  );
}

/** `pdftoppm` を 1 回呼ぶ。PDF を stdin に流し、画像を stdout で受け取る。 */
function runPdftoppm(pdf: Uint8Array, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pdftoppm",
      args,
      { encoding: "buffer", maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(missingBinaryError());
            return;
          }
          reject(
            new Error(`pdftoppm が失敗しました: ${error.message}\n${stderr.toString("utf8")}`),
          );
          return;
        }
        resolve(stdout);
      },
    );
    // ⚠ stdin を閉じないと pdftoppm は読み終わらない。
    //   ⚠ 二進が無いときは stdin も無いので、握りつぶさず ENOENT 側に任せる。
    child.stdin?.on("error", () => {});
    child.stdin?.end(pdf);
  });
}

/**
 * 指定したページを画像にする。**ページ番号は PDF 全体の通し番号 (1 始まり)。**
 *
 * ⚠ **直列に回す。** 1 ページ 0.3 秒ほどで、読み取り (分単位) に対して誤差。
 *   並列にしても得は小さく、Cloud Run の CPU を読み取りと食い合う。
 */
export async function renderPages(
  pdf: Uint8Array,
  pages: readonly number[],
  dpi: number,
): Promise<RenderedPage[]> {
  const rendered: RenderedPage[] = [];
  for (const pageNo of pages) {
    const jpeg = await runPdftoppm(pdf, renderArgs(pageNo, dpi));
    if (jpeg.length === 0) {
      // 範囲の外のページを頼まれた (分類が嘘をついた)。**黙って空を返さない。**
      throw new Error(`${pageNo} ページ目を画像にできませんでした (ページが存在しない可能性)`);
    }
    const size = jpegSize(jpeg);
    if (!size) throw new Error(`${pageNo} ページ目の画像の寸法を読めませんでした`);
    rendered.push({ pageNo, jpeg: new Uint8Array(jpeg), width: size.width, height: size.height });
  }
  return rendered;
}

/**
 * ★ そのノードが読むページだけを、モデルに渡せる形にする。
 *
 * ⚠ **PDF 以外はレンダリングしない。** 画像が直接届いたときは 1 ページとしてそのまま渡す
 *   (いまの取り込みは PDF だけだが、ここで分岐を閉じておく)。
 */
export async function imagesForPages(
  request: Pick<DocExtractRequest, "mediaType" | "dataBase64">,
  pages: readonly number[],
  dpi: number,
  /** 0 なら割らない。2 以上なら、ページ全体に加えて**横帯を拡大した**画像を足す。 */
  bands = 0,
  /** 帯の**後ろ**に足す、紙の一部だけを細かく拡大した画像 (`DetailCrop`)。 */
  details: readonly DetailCrop[] = [],
): Promise<ExtractionImage[]> {
  if (request.mediaType !== PDF_MEDIA_TYPE) {
    return [
      {
        pageNo: 1,
        dataBase64: request.dataBase64,
        mediaType: request.mediaType,
        zoomed: false,
        band: null,
      },
    ];
  }
  const pdf = Buffer.from(request.dataBase64, "base64");
  const images: ExtractionImage[] = [];

  for (const page of await renderPages(pdf, pages, dpi)) {
    images.push({
      pageNo: page.pageNo,
      dataBase64: Buffer.from(page.jpeg).toString("base64"),
      mediaType: PAGE_MEDIA_TYPE,
      zoomed: false,
      band: null,
    });

    // ⚠ 帯は**全体の後ろ**に並べる (全体でページの形を掴んでから細部を見てもらう)。
    const allBands = zoomBands(bands);
    for (const [bandIndex, band] of allBands.entries()) {
      // ⚠ 切り出す範囲は **ZOOM_DPI で描いたときのピクセル**で指定する。
      const width = Math.round((page.width * ZOOM_DPI) / dpi);
      const height = Math.round((page.height * ZOOM_DPI) / dpi);
      const crop = {
        x: 0,
        y: Math.round(band.top * height),
        width,
        height: Math.max(1, Math.round((band.bottom - band.top) * height)),
      };
      const jpeg = await runPdftoppm(pdf, renderArgs(page.pageNo, ZOOM_DPI, crop));
      if (jpeg.length === 0) continue;
      images.push({
        pageNo: page.pageNo,
        dataBase64: Buffer.from(jpeg).toString("base64"),
        mediaType: PAGE_MEDIA_TYPE,
        zoomed: true,
        // ⚠ **上から何番目か**を添える (これが無いと、モデルは帯の位置を知りようがない)。
        band: { index: bandIndex + 1, total: allBands.length },
      });
    }

    // ⚠ 細部の拡大は**帯の後ろ**に並べる (全体 → 帯 → 細部の順で、だんだん寄っていく)。
    for (const detail of details) {
      const crop = detailCropBox(
        detail,
        Math.round((page.width * DETAIL_DPI) / dpi),
        Math.round((page.height * DETAIL_DPI) / dpi),
      );
      const jpeg = await runPdftoppm(pdf, renderArgs(page.pageNo, DETAIL_DPI, crop));
      if (jpeg.length === 0) continue;
      images.push({
        pageNo: page.pageNo,
        dataBase64: Buffer.from(jpeg).toString("base64"),
        mediaType: PAGE_MEDIA_TYPE,
        zoomed: true,
        band: null,
        detail: detail.label,
      });
    }
  }
  return images;
}
