import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocExtractRequest, DocExtractResponse } from "../contract";
import { linkStep } from "./link";

/** ⚠ **モデルの呼び出しを差し替える。** 使い捨ての Agent の `generate` 1 か所だけ。 */
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

beforeEach(() => {
  generate.mockReset();
  vi.stubEnv("AI_DEFAULT_MODEL", "openai/gpt-5");
  vi.stubEnv("LIBSQL_URL", "file:./.mastra/mastra.db");
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const empty = { value: null, quote: null, page: null, confidence: 0 };
const field = (quote: string) => ({ value: quote, quote, page: 1, confidence: 90 });

const request: DocExtractRequest = {
  jobId: "job-1",
  filename: "sample.pdf",
  mediaType: "application/pdf",
  dataBase64: "JVBERi0x",
};

function line(lineNo: number, modelNo: string) {
  return {
    lineNo,
    modelNo: field(modelNo),
    productName: field(`資材名 ${lineNo}`),
    sizeText: empty,
    quantity: empty,
    remarkText: empty,
  };
}

function sheet(specNo: string) {
  return {
    specNo: field(specNo),
    productName: empty,
    purityText: empty,
    requestCategoryText: empty,
    pictures: [],
    specNote: null,
  };
}

function responseOf(lines: ReturnType<typeof line>[], sheets: ReturnType<typeof sheet>[]) {
  return {
    model: "openai/gpt-5",
    inputTokens: 10,
    outputTokens: 2,
    latencyMs: 100,
    rawOutput: JSON.stringify(["分類の生出力", "発注書の生出力"]),
    extraction: {
      formCode: "FORM1",
      purchaseOrder: lines.length > 0 ? { header: {}, lines } : null,
      specSheets: sheets,
      pictures: [],
      links: [],
    },
    classification: {
      formCode: "FORM1",
      formName: "様式パターン①",
      formConfidence: 90,
      pages: [],
      parts: [],
    },
  } as unknown as DocExtractResponse;
}

function run(response: DocExtractResponse) {
  return linkStep.execute({
    inputData: response,
    getInitData: () => request,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as Promise<DocExtractResponse>;
}

describe("linkStep", () => {
  it("明細と依頼書を結んで返す", async () => {
    generate.mockResolvedValue({
      object: { links: [{ lineNo: 1, specSheetIndex: 0, matchedBy: "spec_no", confidence: 95 }] },
      text: "{}",
      totalUsage: { inputTokens: 5, outputTokens: 1 },
      response: { modelId: "openai/gpt-5" },
    });

    const out = await run(responseOf([line(1, "99-05-S001")], [sheet("2099 - 05 - S001")]));
    expect(out.extraction.links).toEqual([
      { lineNo: 1, specSheetIndex: 0, matchedBy: "spec_no", confidence: 95 },
    ]);
  });

  /** ⚠ 結ぶ相手が居ないのにモデルを呼ぶと、無から対応づけを作る。 */
  it("⚠ 依頼書が 0 枚ならモデルを呼ばない", async () => {
    const out = await run(responseOf([line(1, "A")], []));
    expect(generate).not.toHaveBeenCalled();
    expect(out.extraction.links).toEqual([]);
  });

  it("⚠ 発注書が無ければモデルを呼ばない", async () => {
    const out = await run(responseOf([], [sheet("A")]));
    expect(generate).not.toHaveBeenCalled();
    expect(out.extraction.links).toEqual([]);
  });

  /**
   * ⚠⚠ **実在しない番号を通さない。** 添字がずれると、web 側で
   *   **関係のない依頼書が明細に付く**。
   */
  it("⚠⚠ 実在しない lineNo / specSheetIndex は捨てる", async () => {
    generate.mockResolvedValue({
      object: {
        links: [
          { lineNo: 1, specSheetIndex: 0, matchedBy: "spec_no", confidence: 90 },
          { lineNo: 9, specSheetIndex: 0, matchedBy: "spec_no", confidence: 90 },
          { lineNo: 1, specSheetIndex: 7, matchedBy: "other", confidence: 10 },
        ],
      },
      text: "{}",
      totalUsage: { inputTokens: 5, outputTokens: 1 },
      response: { modelId: "openai/gpt-5" },
    });

    const out = await run(responseOf([line(1, "A")], [sheet("A")]));
    expect(out.extraction.links).toEqual([
      { lineNo: 1, specSheetIndex: 0, matchedBy: "spec_no", confidence: 90 },
    ]);
  });

  /** ⚠ 紙は見ないノード。画像を渡さない。 */
  it("⚠ 画像を渡さず、読み取った印字だけを見せる", async () => {
    generate.mockResolvedValue({
      object: { links: [] },
      text: "{}",
      totalUsage: { inputTokens: 5, outputTokens: 1 },
      response: { modelId: "openai/gpt-5" },
    });

    await run(responseOf([line(1, "99-05-S001")], [sheet("2099-05-S001")]));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (generate.mock.calls[0] as any)[1][0].content as { type: string }[];
    expect(content.filter((part) => part.type === "file")).toEqual([]);
    // 印字そのまま (quote) を見せている。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (content.find((part) => part.type === "text") as any).text as string;
    expect(text).toContain("99-05-S001");
    expect(text).toContain("2099-05-S001");
  });

  it("トークンは足し、生出力はノードごとに 1 本足す", async () => {
    generate.mockResolvedValue({
      object: { links: [] },
      text: "対応づけの生出力",
      totalUsage: { inputTokens: 5, outputTokens: 3 },
      response: { modelId: "openai/gpt-5" },
    });

    const out = await run(responseOf([line(1, "A")], [sheet("A")]));
    expect(out.inputTokens).toBe(15);
    expect(out.outputTokens).toBe(5);
    // ⚠⚠ 1 本目は分類のまま (順番を入れ替えない)。
    expect(JSON.parse(out.rawOutput)).toEqual([
      "分類の生出力",
      "発注書の生出力",
      "対応づけの生出力",
    ]);
  });
});
