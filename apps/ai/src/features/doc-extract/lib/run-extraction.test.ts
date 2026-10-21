import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { specSheetExtraction } from "../contract";
import { pageLabels, runExtraction } from "./run-extraction";

/**
 * LLM は呼ばない。**使い捨ての Agent の `generate` だけ**を差し替えて、
 * 「何を渡しているか」と「形の検査」を見る。
 *
 * ⚠ `vi.hoisted` で作る。`vi.mock` は import より前に巻き上げられるので、
 *   ふつうの `const` を参照すると初期化前アクセスで落ちる。
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

/** ⚠ 渡すのは PDF ではなく**描画したページの画像**。1 枚 = 1 つの file part。 */
const images = [
  { pageNo: 2, dataBase64: "/9j/page2", mediaType: "image/jpeg", zoomed: false, band: null },
  { pageNo: 3, dataBase64: "/9j/page3", mediaType: "image/jpeg", zoomed: false, band: null },
];
const page = (pageNo: number, zoomed = false, index = 1, total = 2) => ({
  pageNo,
  dataBase64: `/9j/p${pageNo}${zoomed ? `z${index}` : ""}`,
  mediaType: "image/jpeg",
  zoomed,
  band: zoomed ? { index, total } : null,
});

const empty = { value: null, quote: null, page: null, confidence: 0 };
const ok = {
  specNo: { value: "MFG-000123", quote: "MFG-000123", page: 2, confidence: 90 },
  productName: empty,
  purityText: empty,
  requestCategoryText: empty,
  pictures: [],
  specNote: null,
};

/** `agent.generate` の戻り。実際の形に合わせてある (object / totalUsage / response)。 */
function reply(over: Record<string, unknown> = {}) {
  return {
    object: ok,
    text: "{}",
    totalUsage: { inputTokens: 10, outputTokens: 20 },
    response: { modelId: "gpt-5-2025-08-07" },
    ...over,
  };
}

function call(
  overrides: Partial<Parameters<typeof runExtraction>[0]> = {},
  answer: Record<string, unknown> = reply(),
) {
  generate.mockReset();
  generate.mockResolvedValue(answer);
  const run = runExtraction({
    modelId: "openai/gpt-5",
    instructions: "依頼書を読む担当です",
    label: "依頼書 1 枚目",
    schema: specSheetExtraction,
    images,
    instruction: "依頼書を 1 枚読み取ってください。ファイル名: sample.pdf",
    ...overrides,
  });
  return { run, generate };
}

describe("runExtraction", () => {
  /**
   * ⚠⚠ **渡すのはページの画像で、渡した枚数だけ file part が並ぶ。**
   *   PDF 全体を送っていたころは「n ページ目だけ読んで」と言葉で頼むしかなく、
   *   入力が 3 倍になるうえ隣のページを写すでっち上げが起きた。
   * ⚠ **並びを変えないこと。** `pageLabels()` が「画像の並びがこの順」と言っている。
   */
  it("ページの画像を渡した順に file part として並べる", async () => {
    const { run } = call();
    await run;

    // 1 つ目の引数が Agent の設定、2 つ目が messages。
    const messages = generate.mock.calls[0]?.[1];
    expect(messages[0].content).toEqual([
      { type: "text", text: expect.stringContaining("sample.pdf") },
      { type: "file", data: "/9j/page2", mediaType: "image/jpeg" },
      { type: "file", data: "/9j/page3", mediaType: "image/jpeg" },
    ]);
  });

  /**
   * ⚠⚠ **モデルと指示文は引数。** agent 越しだったころは requestContext に入れて
   *   `generate` の時点で読ませていたため、**並列に読むと最後に書いたノードのモデルが
   *   全ノードに効く**罠があった。引数なら取り違えようがない。
   */
  it("⚠⚠ そのノードのモデルと指示文をそのまま渡す", async () => {
    const { run } = call({ modelId: "openai/gpt-5-mini", instructions: "分類の指示文" });
    await run;

    const config = generate.mock.calls[0]?.[0];
    // ⚠⚠ **値で渡っていること。** 関数 (requestContext から読む形) に戻すと、
    //   並列に走らせたときに取り違える形が戻る。
    expect(config.instructions).toBe("分類の指示文");
    expect(config.model).toBe("openai/gpt-5-mini");
  });

  /**
   * ⚠⚠ 画像が 1 枚も無いまま呼ぶと、モデルは**指示文だけを見て答えをでっち上げる**。
   *   空の結果が「成功」として残るのが一番悪いので、ここで名指しで落とす。
   */
  it("⚠ 画像が 1 枚も無ければ呼ばずに落とす", async () => {
    const { run } = call({ images: [] });
    await expect(run).rejects.toThrow("読み取るページの画像がありません");
    expect(generate).not.toHaveBeenCalled();
  });

  it("⚠ 決めた形から外れたら黙って通さずに落とす", async () => {
    // でっち上げ防止。ここで通すと、空の ORDER SHEET が「成功」として残る。
    const { run } = call({}, reply({ object: { specNo: "生の文字列" } }));
    await expect(run).rejects.toThrow("決めた形と違います");
  });

  /** ⚠ 並列に読むので、**どの枚で落ちたか**が分かる名前を残す。 */
  it("⚠ 落ちたときは、どのノードかを名指しする", async () => {
    const { run } = call({ images: [], label: "依頼書 2 枚目" });
    await expect(run).rejects.toThrow("依頼書 2 枚目");
  });

  it("実際に使われたモデルと usage を記録する", async () => {
    const { run } = call();
    const result = await run;
    expect(result.model).toBe("gpt-5-2025-08-07");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
  });

  it("usage が欠けても落ちない (モデルによっては返らない)", async () => {
    const { run } = call({}, reply({ totalUsage: {}, response: { modelId: "" } }));
    const result = await run;
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // ⚠ env を読みに行かないこと。モデル名が分からなければ null でよい。
    expect(result.model).toBeNull();
  });
});

/**
 * ⚠⚠ 契約の `page` は「**PDF 全体の通し番号**」のまま。渡すのは切り出した画像なので、
 *   これを言わないとモデルは全部 1 ページ目だと答える
 *   (`ai_extraction_fields.page_no` が原本へ戻る唯一の手がかり)。
 */
describe("pageLabels", () => {
  it("添付した画像が元の PDF の何ページ目かを言う", () => {
    expect(pageLabels([page(2)])).toContain("2 ページ目");
    expect(pageLabels([page(2), page(3)])).toContain("2 ・ 3 ページ目");
  });

  it("⚠ 通し番号を page に入れろと念を押す", () => {
    expect(pageLabels([page(2)])).toContain("page");
    expect(pageLabels([page(2)])).toContain("通し番号");
  });

  /**
   * ⚠⚠ **拡大した帯はページ全体と同じ紙。** これを言わないと、石の表の行や明細が
   *   **2 回**出てくる (同じものを別の紙だと思われる)。
   */
  it("⚠⚠ 拡大した画像があれば「二重に数えるな」と言う", () => {
    const text = pageLabels([page(2), page(2, true), page(2, true)]);
    expect(text).toContain("同じページの一部を拡大した画像");
    expect(text).toContain("2 枚続きます");
    expect(text).toContain("二重に数えないでください");
  });

  /**
   * ⚠⚠ **帯がページのどこかを言う。** 言わないとモデルは位置を知りようがなく、
   *   「表題のすぐ下の行」を探しても紙の中ほどの別の行を読んでしまう (実測)。
   */
  it("⚠⚠ 拡大した帯がページの上から何本目かを言う", () => {
    const text = pageLabels([page(2), page(2, true, 1, 6), page(2, true, 2, 6)]);
    expect(text).toContain("上から 6 本の横帯");
    expect(text).toContain("1 本目 → 2 本目");
    expect(text).toContain("上のほう");
  });

  /**
   * ⚠⚠ **細部の拡大も場所を言う**。帯の本数には数えない
   *   (数えると「上から 7 本の横帯」と嘘をつく)。
   */
  it("⚠⚠ 細部の拡大は場所の言葉を添え、帯の本数には数えない", () => {
    const text = pageLabels([
      page(2),
      page(2, true, 6, 6),
      { ...page(2, true), band: null, detail: "紙のいちばん下の左側" },
      { ...page(2, true), band: null, detail: "紙のいちばん下の右側" },
    ]);
    expect(text).toContain("3 枚続きます");
    expect(text).toContain("上から 6 本の横帯");
    expect(text).toContain("渡した順に 6 本目 です");
    expect(text).not.toContain("7 本");
    expect(text).toContain("最後の 2 枚");
    expect(text).toContain("紙のいちばん下の左側 → 紙のいちばん下の右側");
    expect(text).toContain("同じページの一部");
  });

  it("細部の拡大が無ければ、その断りは出さない", () => {
    expect(pageLabels([page(2), page(2, true, 1, 6)])).not.toContain("細かく拡大");
  });

  it("拡大した画像が無ければ、その断りは出さない", () => {
    expect(pageLabels([page(2)])).not.toContain("二重に数えないでください");
  });

  it("同じページの帯を並べてもページ番号は 1 回だけ言う", () => {
    expect(pageLabels([page(2), page(2, true)])).toContain("2 ページ目");
    expect(pageLabels([page(2), page(2, true)])).not.toContain("2 ・ 2");
  });

  it("ページが分からなければ何も言わない", () => {
    expect(pageLabels([])).toBe("");
  });
});

describe("contract", () => {
  it("印字が無い欄は null を許す (埋まらない欄がある方が正しい)", () => {
    expect(
      specSheetExtraction.safeParse({
        specNo: empty,
        productName: empty,
        purityText: empty,
        requestCategoryText: empty,
        pictures: [],
        specNote: null,
      }).success,
    ).toBe(true);
  });

  it("confidence は 0..100 の整数 (ai_extraction_fields に合わせてある)", () => {
    const field = z.object({ confidence: specSheetExtraction.shape.specNo.shape.confidence });
    expect(field.safeParse({ confidence: 0.7 }).success).toBe(false);
    expect(field.safeParse({ confidence: 101 }).success).toBe(false);
    expect(field.safeParse({ confidence: 70 }).success).toBe(true);
  });
});
