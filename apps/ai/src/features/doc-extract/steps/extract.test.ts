import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocExtractRequest, DocExtractResponse } from "../contract";
import { imagesForPages } from "../lib/page-images";
import { promptFor } from "../prompts";
import type * as PageImages from "../lib/page-images";
import { extractStep } from "./extract";

/**
 * ⚠⚠ **ここが「決定的であること」の固定。**
 *   分類が「依頼書 2 枚」と言えば、読み取りは**必ず 2 回**走る。
 *   1 つの agent に任せると、枚数を落としても誰も気づけない。
 *
 * ⚠ **レンダリングは差し替える。** 本物は `pdftoppm` を呼ぶので、ここで走らせると
 *   テストが二進と実物の PDF に依存する。**渡すページの番号が正しいか**だけを見る。
 */
/**
 * ⚠ **モデルの呼び出しを差し替える。** 登録した agent を引くのをやめたので、
 *   差し替える先は「使い捨ての Agent の `generate`」1 か所だけ。
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
  // ⚠ step は「どのモデルで聞くか」を決めるので、指定が無いノードのために既定を読む。
  //   `apps/ai/.env.example` と同じ値を立てておく。
  vi.stubEnv("AI_DEFAULT_MODEL", "openai/gpt-5");
  vi.stubEnv("LIBSQL_URL", "file:./.mastra/mastra.db");
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const empty = { value: null, quote: null, page: null, confidence: 0 };

const poResult = {
  header: { customerPoNo: empty },
  lines: [],
};
const sheetResult = {
  specNo: empty,
  productName: empty,
  purityText: empty,
  requestCategoryText: empty,
  pictures: [],
};

const request: DocExtractRequest = {
  jobId: "job-1",
  filename: "sample.pdf",
  mediaType: "application/pdf",
  dataBase64: "JVBERi0x",
};

/** 1 回の呼び出しの前置き (どのノードかはこの文面で決まる)。 */
function textOf(messages: { content: { type: string; text?: string }[] }[]): string {
  return messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
}

/** その呼び出しがどのノードか。⚠ 並列なので**呼ばれた順では決められない**。 */
function nodeOf(messages: Parameters<typeof textOf>[0]): "発注書" | "依頼書" {
  return textOf(messages).includes("発注書を読み取って") ? "発注書" : "依頼書";
}

/** ノードごとに何を返すかを決めた偽のモデル呼び出し。 */
function fakeModel(options: { failSpecSheetOnPage?: number } = {}) {
  generate.mockReset();
  generate.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (_config: any, messages: Parameters<typeof textOf>[0]) => {
      const text = textOf(messages);
      const isPurchaseOrder = nodeOf(messages) === "発注書";
      if (
        options.failSpecSheetOnPage !== undefined &&
        !isPurchaseOrder &&
        text.includes(`${options.failSpecSheetOnPage} ページ目`)
      ) {
        throw new Error("モデルが応答しませんでした");
      }
      return {
        object: isPurchaseOrder ? poResult : sheetResult,
        text: "{}",
        totalUsage: { inputTokens: 10, outputTokens: 2 },
        response: { modelId: "openai/gpt-5-mini" },
      };
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = () => generate.mock.calls.map((call: any) => nodeOf(call[1]));
  return { nodes };
}

function run(
  parts: { role: "purchase_order" | "spec_sheet" | "unknown"; pages: number[] }[],
  overrides: Partial<DocExtractRequest> = {},
  formCode: string | null = null,
  fakeOptions: { failSpecSheetOnPage?: number } = {},
) {
  const { nodes } = fakeModel(fakeOptions);
  // ⚠ step.execute の戻りは「suspend したとき」との union なので、出力の形に絞る。
  const result = extractStep.execute({
    inputData: {
      classification: {
        // ⚠ 様式は束に 1 つ。ページごとに持たせない。
        formCode,
        formName: null,
        formConfidence: 90,
        // ⚠⚠ **parts はコードが組み立てたもの** (`lib/group-parts.ts`)。
        //   読み取りが何回走るかはこの数で決まる。
        pages: parts.flatMap((part) =>
          part.pages.map((page) => ({
            page,
            docType: part.role === "unknown" ? "other" : part.role,
            headerQuote: null,
            startsNewSheet: true,
            confidence: 90,
          })),
        ),
        parts: parts.map((part) => ({ ...part, confidence: 90 })),
      },
      promptId: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 1,
      rawOutput: "{}",
    },
    // ⚠⚠ **PDF は step の入出力に載せない。** workflow の入力から読む
    //   (載せるとトレースにも snapshot にも base64 が何度も書かれる)。
    getInitData: () => ({ ...request, ...overrides }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as Promise<DocExtractResponse>;
  return { result, nodes, generate };
}

describe("extractStep", () => {
  it("依頼書が 2 枚なら読み取りが 2 回走る", async () => {
    const { result, nodes } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);
    const out = await result;

    expect(nodes().sort()).toEqual(["依頼書", "依頼書", "発注書"]);
    expect(out.extraction.specSheets).toHaveLength(2);
    expect(out.extraction.purchaseOrder).not.toBeNull();
  });

  it("発注書が無ければ読み取りを呼ばず null を返す (依頼書だけの PDF)", async () => {
    const { result, nodes } = run([{ role: "spec_sheet", pages: [1] }]);
    const out = await result;

    expect(nodes()).toEqual(["依頼書"]);
    expect(out.extraction.purchaseOrder).toBeNull();
    expect(out.extraction.specSheets).toHaveLength(1);
  });

  it("依頼書が無ければ空の配列 (発注書だけの PDF)", async () => {
    const { result, nodes } = run([{ role: "purchase_order", pages: [1] }]);
    const out = await result;

    expect(nodes()).toEqual(["発注書"]);
    expect(out.extraction.specSheets).toEqual([]);
  });

  /**
   * ⚠⚠ **このノードは図のことを一切聞かない**。座標を同じ呼び出しで
   *   聞いていたころ、区分と REMARK が実行ごとに落ちていた。枠を入れるのは
   *   `steps/locate-pictures.ts`、切り出すのは `steps/crop-pictures.ts`。
   */
  it("⚠⚠ 写真も枠もこのノードでは入れない", async () => {
    const { result } = run([{ role: "spec_sheet", pages: [1] }]);
    const out = await result;

    // 切り出した写真。
    expect(out.extraction.pictures).toEqual([]);
    // 枠 (モデルが答える座標) も空のまま出す。
    expect(out.extraction.specSheets[0]?.pictures).toEqual([]);
  });

  /**
   * ⚠⚠ **下部のメモもこのノードでは聞かない**。欄の読み取りに足すと、
   *   区分が再び落ちうる。読むのは `steps/read-spec-notes.ts`。
   */
  it("⚠⚠ 下部のメモもこのノードでは入れない", async () => {
    const { result } = run([{ role: "spec_sheet", pages: [1] }]);
    const out = await result;

    expect(out.extraction.specSheets[0]?.specNote).toBeNull();
  });

  it("⚠ unknown のページは読まない (読めないものを読んだふりにしない)", async () => {
    const { result, nodes } = run([{ role: "unknown", pages: [1] }]);
    const out = await result;

    expect(nodes()).toEqual([]);
    // ⚠ 描きもしない (読まないページに CPU を使わない)。
    expect(renderedFor).not.toHaveBeenCalled();
    expect(out.extraction.purchaseOrder).toBeNull();
    expect(out.extraction.specSheets).toEqual([]);
  });

  /**
   * ⚠⚠ **そのノードに要るページの画像だけを渡す。**
   *   以前は 4 回とも PDF 全体を送り、「n ページ目だけ読んで」と言葉で頼んでいた。
   *   隣のページが見えているせいで**1 枚目の石を 2 枚目に写すでっち上げ**が実際に起きた。
   *   入力も 3 倍になっていた。**見せないほうが確実。**
   */
  it("⚠⚠ その部品のページだけを画像にして渡す (他のページを見せない)", async () => {
    const { result, generate } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [3] },
    ]);
    await result;

    // 描いたのは 1 ページ目と 3 ページ目だけ (2 ページ目は誰にも見せていない)。
    expect(renderedFor.mock.calls.map((call) => call[1])).toEqual([[1], [3]]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents = generate.mock.calls.map((call: any) => call[1][0].content);
    expect(contents[0].filter((p: { type: string }) => p.type === "file")).toEqual([
      { type: "file", data: "/9j/p1", mediaType: "image/jpeg" },
    ]);
    expect(contents[1].filter((p: { type: string }) => p.type === "file")).toEqual([
      { type: "file", data: "/9j/p3", mediaType: "image/jpeg" },
    ]);
    // ⚠ 拡大した帯も足して頼んでいる (細かい印字はページ全体では読めない)。
    expect(renderedFor.mock.calls.every((call) => (call[3] ?? 0) > 0)).toBe(true);
  });

  /** ⚠ 契約の `page` は PDF 全体の通し番号のまま。画像だけ渡すと分からないので言葉で添える。 */
  it("添付した画像が元の PDF の何ページ目かを instruction で言う", async () => {
    const { result, generate } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [3] },
    ]);
    await result;

    const texts = generate.mock.calls.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any) => call[1][0].content.find((p: { type: string }) => p.type === "text").text,
    );
    expect(texts[0]).toContain("1 ページ目");
    expect(texts[1]).toContain("3 ページ目");
  });

  /**
   * ⚠⚠ **ノードごとに指示文が分かれていること。**
   *   agent 越しだったころは `requestContext` の `"model"` という**ただ 1 つの鍵**を
   *   `generate` の時点で遅延して読んでいたため、**並列にした瞬間に「最後に書いたノードの
   *   モデル」が全ノードに効く**という罠があった。いまは**ただの引数**なので起きない。
   *   ⚠ ここを requestContext 越しや関数に戻さないこと。
   */
  it("⚠⚠ ノードごとに独立した指示文が渡る (並列でも取り違えない)", async () => {
    const { result, generate } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [2] },
    ]);
    await result;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byNode = new Map<string, any>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generate.mock.calls.map((call: any) => [nodeOf(call[1]), call[0]]),
    );
    // ⚠ **2 つとも自分の指示文を持っている** (どちらかに揃っていたら並列で壊れている)。
    expect(byNode.get("発注書").instructions).toBe(promptFor("purchase_order", null));
    expect(byNode.get("依頼書").instructions).toBe(promptFor("spec_sheet", null));
    expect(byNode.get("発注書").instructions).not.toBe(byNode.get("依頼書").instructions);
  });

  /**
   * ★ 様式が決まってから指示文を引く。**分類より前には決まらない**ので、
   *   ここでしか様式ごとの差分を差し込めない。
   */
  it("★ 分類が選んだ様式の指示文が読み取りノードに渡る", async () => {
    const { result, generate } = run([{ role: "purchase_order", pages: [1] }], {}, "FORM1");
    await result;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((generate.mock.calls[0] as any)[0].instructions).toBe(
      promptFor("purchase_order", "FORM1"),
    );
  });

  /**
   * ⚠⚠ **どの枚で落ちたかが分かること**を維持する。並列にすると、素の例外だけでは
   *   何枚目が壊れたのか分からなくなる (直列のときは順番で分かっていた)。
   */
  it("⚠⚠ 依頼書が失敗したら何枚目かを名指しで言う", async () => {
    const { result } = run(
      [
        { role: "spec_sheet", pages: [2] },
        { role: "spec_sheet", pages: [3] },
      ],
      {},
      null,
      { failSpecSheetOnPage: 3 },
    );
    await expect(result).rejects.toThrow("依頼書 2 枚目 (3 ページ目)");
  });

  it("⚠ 様式は分類が 1 つだけ選ぶ (部品ごとに違う様式を名乗らない)", async () => {
    const { result } = run([{ role: "purchase_order", pages: [1] }], {}, "form-1");
    expect((await result).extraction.formCode).toBe("form-1");
  });

  /**
   * ⚠ **トークンは合計、時間は実時間。**
   *   費用は足し算で増えるが、並列に読むので latency を足すと実際にかかった時間を超える。
   */
  it("トークンは全ノードの合計", async () => {
    const { result } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [2] },
    ]);
    const out = await result;
    // 分類 (null) + 発注書 10 + 依頼書 10
    expect(out.inputTokens).toBe(20);
    expect(out.outputTokens).toBe(4);
  });

  it("⚠⚠ 時間は実時間 (ノードの合計にしない)", async () => {
    const { result } = run([
      { role: "purchase_order", pages: [1] },
      { role: "spec_sheet", pages: [2] },
      { role: "spec_sheet", pages: [3] },
    ]);
    const out = await result;
    // 分類の 1ms + このノードの壁時計。**3 回ぶんの足し算にはならない。**
    expect(out.latencyMs).toBeGreaterThanOrEqual(1);
    expect(out.latencyMs).toBeLessThan(5_000);
  });
});
