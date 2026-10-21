import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocExtractRequest, DocExtractResponse } from "../contract";
import { imagesForPages } from "../lib/page-images";
import type * as PageImages from "../lib/page-images";
import { locatePicturesStep } from "./locate-pictures";

/**
 * ⚠⚠ **ここが「場所を別の呼び出しで聞く」ことの固定。**
 *   欄の読み取り (`steps/extract.ts`) と同じ呼び出しで座標も聞いていたころ、
 *   実行ごとに区分や REMARK が落ちていた (実測)。
 *   ⚠ 回数を決めるのは**コード**（分類が組み立てた `parts`）で、モデルではない。
 */
const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(readonly config: any) {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generate(...args: any[]) {
      return generate(this.config, ...args);
    }
  },
}));

vi.mock("../lib/page-images", async (importOriginal) => ({
  ...(await importOriginal<typeof PageImages>()),
  imagesForPages: vi.fn(async (_request: unknown, pages: readonly number[]) =>
    pages.map((pageNo) => ({
      pageNo,
      dataBase64: `/9j/p${pageNo}`,
      mediaType: "image/jpeg",
      zoomed: false,
      band: null,
    })),
  ),
}));

const renderedFor = vi.mocked(imagesForPages);

beforeEach(() => {
  renderedFor.mockClear();
  vi.stubEnv("AI_DEFAULT_MODEL", "openai/gpt-5");
  vi.stubEnv("LIBSQL_URL", "file:./.mastra/mastra.db");
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const empty = { value: null, quote: null, page: null, confidence: 0 };

const request: DocExtractRequest = {
  jobId: "job-1",
  filename: "sample.pdf",
  mediaType: "application/pdf",
  dataBase64: "JVBERi0x",
};

function box(page: number) {
  return {
    page,
    x: 0.1,
    y: 0.6,
    width: 0.07,
    height: 0.07,
    confidence: 60,
    labelQuote: "（完成イメージ）",
  };
}

function sheet() {
  return {
    specNo: empty,
    productName: empty,
    purityText: empty,
    requestCategoryText: empty,
    pictures: [],
    specNote: null,
  };
}

/** 1 回の呼び出しの前置き。⚠ 並列なので**呼ばれた順では何枚目か決められない**。 */
function textOf(messages: { content: { type: string; text?: string }[] }[]): string {
  return messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
}

function fakeModel(options: { failOnPage?: number } = {}) {
  generate.mockReset();
  generate.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (_config: any, messages: Parameters<typeof textOf>[0]) => {
      const text = textOf(messages);
      if (options.failOnPage !== undefined && text.includes(`${options.failOnPage} ページ目`)) {
        throw new Error("モデルが応答しませんでした");
      }
      // ⚠ どのページを渡されたかで答えを変える (添字どおりに埋まるかを見るため)。
      const pageNo = Number(/元の PDF の (\d+)/u.exec(text)?.[1] ?? 0);
      return {
        object: { pictures: [box(pageNo)] },
        text: `{"page":${pageNo}}`,
        totalUsage: { inputTokens: 7, outputTokens: 3 },
        response: { modelId: "openai/gpt-5-mini" },
      };
    },
  );
}

function run(
  parts: { role: "purchase_order" | "spec_sheet" | "unknown"; pages: number[] }[],
  sheets = parts.filter((part) => part.role === "spec_sheet").map(() => sheet()),
  fakeOptions: { failOnPage?: number } = {},
) {
  fakeModel(fakeOptions);
  const result = locatePicturesStep.execute({
    inputData: {
      extraction: {
        formCode: null,
        purchaseOrder: null,
        specSheets: sheets,
        pictures: [],
        links: [],
      },
      classification: {
        formCode: null,
        formName: null,
        formConfidence: 90,
        pages: [],
        parts: parts.map((part) => ({ ...part, confidence: 90 })),
      },
      model: null,
      inputTokens: 10,
      outputTokens: 4,
      latencyMs: 100,
      // ⚠⚠ 1 本目は**分類の生出力**。ここが動かないことを下で固定する。
      rawOutput: JSON.stringify(["分類の生出力", "依頼書の生出力"]),
    },
    getInitData: () => request,
    writer: { write: () => undefined },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as Promise<DocExtractResponse>;
  return { result };
}

describe("locatePicturesStep", () => {
  it("依頼書が 2 枚なら場所の読み取りが 2 回走る", async () => {
    const { result } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);
    const out = await result;

    expect(generate).toHaveBeenCalledTimes(2);
    expect(out.extraction.specSheets).toHaveLength(2);
  });

  /** ⚠⚠ 枠は**添字どおり**に埋める。push にすると終わった順になり、写真が別の明細に付く。 */
  it("⚠⚠ 枠が依頼書の添字どおりに埋まる", async () => {
    const { result } = run([
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [5] },
    ]);
    const out = await result;

    expect(out.extraction.specSheets[0]?.pictures[0]?.page).toBe(2);
    expect(out.extraction.specSheets[1]?.pictures[0]?.page).toBe(5);
  });

  it("依頼書が 0 枚ならモデルを呼ばず、そのまま返す", async () => {
    const { result } = run([{ role: "purchase_order", pages: [1] }]);
    const out = await result;

    expect(generate).not.toHaveBeenCalled();
    expect(out.extraction.specSheets).toEqual([]);
  });

  /** ⚠ その部品のページだけを描く (隣の依頼書を見せない)。 */
  it("そのノードのページだけを描く", async () => {
    const { result } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);
    await result;

    expect(renderedFor.mock.calls.map((call) => call[1])).toEqual([[2], [3]]);
  });

  /**
   * ⚠⚠ **帯を渡す。実測で、渡さないと枠が 3 倍に太った**:
   *   帯 6 では面積 0.0048 / 0.0080、帯 0 では 0.0192 / 0.0144 (実物は 0.005 ほど)。
   *   ページ全体の 1 枚だけでは、**図の端がどこで終わるかを決められる画素が無い**。
   *   ⚠ 「帯だと帯基準の y を返すのでは」という懸念は実測で否定された
   *     (`steps/locate-pictures.ts` の `PICTURE_ZOOM_BANDS` の注記)。
   */
  it("⚠⚠ 帯 (拡大した横帯) を渡す", async () => {
    const { result } = run([{ role: "spec_sheet", pages: [2] }]);
    await result;

    expect(renderedFor.mock.calls.every((call) => (call[3] ?? 0) > 0)).toBe(true);
  });

  /** ⚠⚠ rawOutput の 1 本目は分類のまま (分類が外したときに人が気づける唯一の場所)。 */
  it("⚠⚠ 生出力は末尾に足され、1 本目は分類のまま", async () => {
    const { result } = run([
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);
    const out = await result;

    const raw = JSON.parse(out.rawOutput) as string[];
    expect(raw[0]).toBe("分類の生出力");
    expect(raw).toHaveLength(4);
  });

  it("費用は足し、時間は合計にしない", async () => {
    const { result } = run([
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);
    const out = await result;

    expect(out.inputTokens).toBe(10 + 7 * 2);
    expect(out.outputTokens).toBe(4 + 3 * 2);
    // ⚠ 前の段の実時間 + この段の壁時計。ノードの latency の合計にはしない。
    expect(out.latencyMs).toBeGreaterThanOrEqual(100);
    expect(out.latencyMs).toBeLessThan(5_000);
  });

  /** ⚠⚠ 並列なので、素の例外だけでは何枚目が壊れたのか分からない。 */
  it("⚠⚠ 失敗はどの依頼書かを名指しする", async () => {
    const { result } = run(
      [
        { role: "spec_sheet", pages: [2] },
        { role: "spec_sheet", pages: [3] },
      ],
      undefined,
      { failOnPage: 3 },
    );

    await expect(result).rejects.toThrow(/依頼書 2 枚目.*3 ページ目/u);
  });
});
