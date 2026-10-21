import { encode } from "jpeg-js";
import { describe, expect, it, vi } from "vitest";
import type { DocExtractRequest, DocExtractResponse } from "../contract";
import { renderPages } from "../lib/page-images";
import { cropPicturesStep, cropPicturesStepId } from "./crop-pictures";

/**
 * ⚠⚠ **このテストが守っているのは 1 つだけ: 「始めた段は必ず終わる」。**
 *
 *   以前は `running` を流したあと、**枠が 1 つも無い / ページが読めない / ページ番号が
 *   範囲外**の 3 つの分かれ道で `return response` していて、**`succeeded` を流さないまま**
 *   抜けていた。web は `progress_json` をノードの鍵で畳み、段の状態を
 *   「全部 succeeded か」で決める (`cases/lib/progress.ts` の `statusOfNodes`) ので、
 *   **代表の図が 1 枚も無い PDF では画面の「整形中」が終わらない。**
 *   ⚠ ジョブ自体は成功して終わるので、**失敗として現れない**のが厄介なところ。
 */

/** ⚠ 本物は `pdftoppm` を呼ぶ。二進と実物の PDF にテストを依存させない。 */
vi.mock("../lib/page-images", () => ({
  CROP_DPI: 300,
  renderPages: vi.fn(async () => []),
}));
vi.mock("../lib/pdf-pages", () => ({ countPages: vi.fn(() => 3) }));

const empty = { value: null, quote: null, page: null, confidence: 0 };

const request: DocExtractRequest = {
  jobId: "job-1",
  filename: "sample.pdf",
  mediaType: "application/pdf",
  dataBase64: "JVBERi0x",
};

function sheet(pictures: DocExtractResponse["extraction"]["specSheets"][number]["pictures"]) {
  return {
    specNo: empty,
    productName: empty,
    purityText: empty,
    requestCategoryText: empty,
    pictures,
    specNote: null,
  };
}

function run(specSheets: ReturnType<typeof sheet>[]) {
  const events: { node: string; status: string }[] = [];
  const result = cropPicturesStep.execute({
    inputData: {
      extraction: { formCode: null, purchaseOrder: null, specSheets, pictures: [], links: [] },
      classification: { formCode: null, formName: null, formConfidence: 0, pages: [], parts: [] },
      model: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 1,
      rawOutput: "[]",
    },
    getInitData: () => request,
    writer: {
      write: (chunk: { node: string; status: string }) => {
        events.push({ node: chunk.node, status: chunk.status });
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as Promise<DocExtractResponse>;
  return { result, events };
}

describe("cropPicturesStep", () => {
  it("⚠⚠ 枠が 1 つも無くても succeeded を流す (画面の「整形中」が終わらなくなる)", async () => {
    const { result, events } = run([sheet([]), sheet([])]);
    const out = await result;

    expect(events).toEqual([
      { node: cropPicturesStepId, status: "running" },
      { node: cropPicturesStepId, status: "succeeded" },
    ]);
    // ⚠ 切れなかったものは入れない。**空が正常**。
    expect(out.extraction.pictures).toEqual([]);
  });

  it("⚠ ページ番号が範囲の外だけでも succeeded を流す", async () => {
    // ⚠ `countPages` は 3 を返す。9 ページ目は描かずに捨てられる経路。
    const { result, events } = run([
      sheet([
        { page: 9, x: 0.1, y: 0.6, width: 0.07, height: 0.07, confidence: 60, labelQuote: null },
      ]),
    ]);
    const out = await result;

    expect(events.map((e) => e.status)).toEqual(["running", "succeeded"]);
    expect(out.extraction.pictures).toEqual([]);
  });

  it("依頼書が 0 枚でも succeeded を流す", async () => {
    const { result, events } = run([]);
    await result;
    expect(events.map((e) => e.status)).toEqual(["running", "succeeded"]);
  });

  /**
   * ⚠⚠ **モデルの枠をそのまま切らない。** 下の段まで伸びた枠でも、切るのは図 1 つ。
   *   寄せる規則そのものは `lib/snap-box.test.ts` が固定する。ここは**配線**だけを見る
   *   (寄せた枠で切る / 出力の `box` は切った枠 / モデルの枠は `specSheets` に残る)。
   */
  it("⚠⚠ 寄せた枠で切り、出力の box は実際に切った枠になる", async () => {
    // 75 dpi 相当の小さなページ。写真が 2 段に並んでいる (隙間 20 px)。
    const width = 620;
    const height = 880;
    const data = new Uint8Array(width * height * 4).fill(255);
    const paint = (x: number, y: number, w: number, h: number) => {
      for (let row = y; row < y + h; row++) {
        for (let col = x; col < x + w; col++) data.fill(120, (row * width + col) * 4, (row * width + col) * 4 + 3);
      }
    };
    paint(60, 500, 60, 60); // ← 狙いの図
    paint(60, 580, 60, 60); // ← 下の段の図
    const jpeg = new Uint8Array(encode({ data, width, height }, 95).data);
    vi.mocked(renderPages).mockResolvedValueOnce([{ pageNo: 2, jpeg, width, height }]);

    // モデルの枠: 下の段まで入っている (実測でよくある形)。
    const model = {
      page: 2,
      x: 50 / width,
      y: 490 / height,
      width: 80 / width,
      height: 170 / height,
      confidence: 60,
      labelQuote: null,
    };
    const { result } = run([sheet([model])]);
    const out = await result;

    expect(out.extraction.pictures).toHaveLength(1);
    const cut = out.extraction.pictures[0]!.box;
    // 上の段の図だけ (余白は 1 px ほど)。
    expect(cut.x * width).toBeGreaterThan(55);
    expect((cut.x + cut.width) * width).toBeLessThan(125);
    expect(cut.y * height).toBeGreaterThan(495);
    expect((cut.y + cut.height) * height).toBeLessThan(570);
    // ⚠ 契約の他の欄はモデルの答えのまま。
    expect(cut.labelQuote).toBeNull();
    expect(cut.confidence).toBe(60);
    // ⚠ モデルが答えた枠は `specSheets` に残る (寄せる前後を比べられる)。
    expect(out.extraction.specSheets[0]!.pictures[0]).toEqual(model);
  });
});
