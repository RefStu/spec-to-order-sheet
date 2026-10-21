import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocExtractRequest, DocExtractResponse } from "../contract";
import { imagesForPages } from "../lib/page-images";
import type * as PageImages from "../lib/page-images";
import { readSpecNotesStep } from "./read-spec-notes";

/**
 * ⚠⚠ 下部のメモ (**将来は消す**) を**別の呼び出しで**読むことの固定。
 *   形は `steps/locate-pictures.ts` と同じで、回数を決めるのは**コード** (分類の `parts`)。
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
const progressWrite = vi.fn();

beforeEach(() => {
  renderedFor.mockClear();
  progressWrite.mockClear();
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

/** ⚠ 架空の値 (実物の値を書かない)。どのページを読んだかが分かるように page を入れる。 */
function note(pageNo: number) {
  const field = (value: string) => ({ value, quote: value, page: pageNo, confidence: 80 });
  return {
    sizeText: empty,
    stoneText: field(`石-${pageNo}`),
    description2: field(`仕上げ-${pageNo}`),
    description3: empty,
    description4: empty,
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
      const pageNo = Number(/元の PDF の (\d+)/u.exec(text)?.[1] ?? 0);
      return {
        object: note(pageNo),
        text: `{"page":${pageNo}}`,
        totalUsage: { inputTokens: 5, outputTokens: 2 },
        response: { modelId: "openai/gpt-5-mini" },
      };
    },
  );
}

function run(
  parts: { role: "purchase_order" | "spec_sheet" | "unknown"; pages: number[] }[],
  fakeOptions: { failOnPage?: number } = {},
) {
  fakeModel(fakeOptions);
  return readSpecNotesStep.execute({
    inputData: {
      extraction: {
        formCode: null,
        purchaseOrder: null,
        specSheets: parts.filter((part) => part.role === "spec_sheet").map(() => sheet()),
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
      rawOutput: JSON.stringify(["分類の生出力", "依頼書の生出力"]),
    },
    getInitData: () => request,
    writer: { write: progressWrite },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as Promise<DocExtractResponse>;
}

describe("readSpecNotesStep", () => {
  it("依頼書が 2 枚ならメモの読み取りが 2 回走る", async () => {
    await run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(renderedFor.mock.calls.map((call) => call[1])).toEqual([[2], [3]]);
  });

  /** ⚠⚠ **添字どおり**に埋める。push にすると終わった順になり、メモが別の明細に付く。 */
  it("⚠⚠ メモが依頼書の添字どおりに埋まる", async () => {
    const out = await run([
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [5] },
    ]);

    expect(out.extraction.specSheets[0]?.specNote?.stoneText.value).toBe("石-2");
    expect(out.extraction.specSheets[1]?.specNote?.stoneText.value).toBe("石-5");
    // ⚠ 他の欄 (図の枠など) には触らない。
    expect(out.extraction.specSheets[0]?.pictures).toEqual([]);
  });

  it("依頼書が 0 枚ならモデルを呼ばず、そのまま返す", async () => {
    const out = await run([{ role: "purchase_order", pages: [1] }]);

    expect(generate).not.toHaveBeenCalled();
    expect(out.extraction.specSheets).toEqual([]);
  });

  /** ⚠ メモは紙の下端の小さな活字。帯を渡さないと読める画素が足りない。 */
  it("帯 (拡大した横帯) を渡す", async () => {
    await run([{ role: "spec_sheet", pages: [2] }]);

    expect(renderedFor.mock.calls.every((call) => (call[3] ?? 0) > 0)).toBe(true);
  });

  /**
   * ⚠⚠ **紙の下を横にも割って細かく拡大した画像を足す**。帯だけでは小さなタイ文字が
   *   別の文字に化けた。左右は重ねる (境目の文字を切らない)。
   */
  it("⚠⚠ 紙の下の余白を左右に割った細部の拡大を渡す", async () => {
    await run([{ role: "spec_sheet", pages: [2] }]);

    const details = renderedFor.mock.calls[0]?.[4] ?? [];
    expect(details).toHaveLength(2);
    for (const detail of details) {
      // 紙のいちばん下まで写す。
      expect(detail.bottom).toBe(1);
      expect(detail.top).toBeGreaterThan(0.5);
      expect(detail.label).toContain("いちばん下");
    }
    const [left, right] = details;
    expect(left!.left).toBe(0);
    expect(right!.right).toBe(1);
    expect(left!.right).toBeGreaterThan(right!.left);
  });

  /**
   * ⚠⚠ **画面の進捗に「下部のメモ (依頼書 n 枚目)」を出さない**。
   *   `lib/progress.ts` の `extractNodesOf()` にも載せていないので、流すと
   *   画面に知らない行が増える。
   */
  it("⚠⚠ 進捗を流さない", async () => {
    await run([
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);

    expect(progressWrite).not.toHaveBeenCalled();
  });

  it("費用は足し、生出力は末尾に足して 1 本目は分類のまま", async () => {
    const out = await run([
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);

    expect(out.inputTokens).toBe(10 + 5 * 2);
    expect(out.outputTokens).toBe(4 + 2 * 2);
    const raw = JSON.parse(out.rawOutput) as string[];
    expect(raw[0]).toBe("分類の生出力");
    expect(raw).toHaveLength(4);
  });

  /** ⚠⚠ 並列なので、素の例外だけでは何枚目が壊れたのか分からない。 */
  it("⚠⚠ 失敗はどの依頼書かを名指しする", async () => {
    await expect(
      run(
        [
          { role: "spec_sheet", pages: [2] },
          { role: "spec_sheet", pages: [3] },
        ],
        { failOnPage: 3 },
      ),
    ).rejects.toThrow(/下部のメモ \(依頼書 2 枚目\).*3 ページ目/u);
  });
});
