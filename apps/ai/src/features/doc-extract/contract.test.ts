import { describe, expect, it } from "vitest";
import {
  documentClassification,
  documentExtraction,
  docExtractRequestSchema,
  purchaseOrderExtraction,
  specSheetExtraction,
} from "./contract";

const empty = { value: null, quote: null, page: null, confidence: 0 };
const po = { header: { customerPoNo: empty }, lines: [] };
const sheet = {
  specNo: empty,
  productName: empty,
  purityText: empty,
  requestCategoryText: empty,
  pictures: [],
  specNote: null,
};

describe("documentExtraction", () => {
  it("発注書だけの PDF", () => {
    const parsed = documentExtraction.safeParse({
      formCode: null,
      purchaseOrder: po,
      specSheets: [],
      pictures: [],
      links: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("依頼書だけの PDF (発注書は null)", () => {
    const parsed = documentExtraction.safeParse({
      formCode: null,
      purchaseOrder: null,
      specSheets: [sheet],
      pictures: [],
      links: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("⚠ 依頼書は複数枚入る (1 通の PDF に明細の数だけ)", () => {
    const parsed = documentExtraction.safeParse({
      formCode: "P1",
      purchaseOrder: po,
      specSheets: [sheet, sheet],
      pictures: [],
      links: [],
    });
    expect(parsed.success && parsed.data.specSheets).toHaveLength(2);
  });

  it("specSheets が欠けていたら通さない (「読めなかった」と「無かった」を混ぜない)", () => {
    expect(
      documentExtraction.safeParse({ formCode: null, purchaseOrder: po, pictures: [] }).success,
    ).toBe(false);
  });
});

describe("documentClassification", () => {
  const classification = (over: Record<string, unknown> = {}) => ({
    formCode: "FORM1",
    formName: "様式パターン①",
    formConfidence: 90,
    pages: [
      {
        page: 1,
        docType: "purchase_order",
        headerQuote: "発注書",
        startsNewSheet: true,
        confidence: 90,
      },
    ],
    parts: [{ role: "purchase_order", pages: [1], confidence: 90 }],
    ...over,
  });

  it("ページを持たない部品は通さない", () => {
    expect(
      documentClassification.safeParse(
        classification({ parts: [{ role: "purchase_order", pages: [], confidence: 90 }] }),
      ).success,
    ).toBe(false);
  });

  it("様式が分からなければ null (判定していないものを名乗らせない)", () => {
    expect(documentClassification.safeParse(classification({ formCode: null })).success).toBe(true);
  });

  it("⚠⚠ 様式は束に 1 つ。部品ごとに様式を名乗らせない", () => {
    const parsed = documentClassification.safeParse(
      classification({
        parts: [{ role: "purchase_order", pages: [1], formCode: "FORM2", confidence: 90 }],
      }),
    );
    // zod は余分な鍵を落とすので、**部品に様式が残らない**ことを確かめる。
    expect(parsed.success && parsed.data.parts[0]).not.toHaveProperty("formCode");
  });

  it("⚠ 部品が 1 つも無くても通る (「1 つも分からなかった」を表せる形にしておく)", () => {
    const parsed = documentClassification.safeParse(
      classification({ formCode: null, formConfidence: 0, parts: [] }),
    );
    expect(parsed.success).toBe(true);
  });

  it("⚠ 部品の役割は 3 つだけ。様式の性質 (mixed) をページの役割にしない", () => {
    expect(
      documentClassification.safeParse(
        classification({ parts: [{ role: "mixed", pages: [1], confidence: 90 }] }),
      ).success,
    ).toBe(false);
  });
});

describe("docExtractRequestSchema", () => {
  const base = {
    jobId: "job-1",
    filename: "a.pdf",
    mediaType: "application/pdf",
    dataBase64: "JVBERi0x",
  };

  it("PDF とジョブの情報だけで通る", () => {
    expect(docExtractRequestSchema.safeParse(base).success).toBe(true);
  });

  /**
   * ⚠⚠ **指示文も様式の候補も受け取らない**。
   *   正は ai の `prompts/` のファイル (git)。余計な欄が来ても**黙って無視する**
   *   (web を先にデプロイしても壊れないように)。
   */
  it("⚠ 指示文や様式の候補が来ても無視する", () => {
    const parsed = docExtractRequestSchema.safeParse({
      ...base,
      formProfiles: [{ code: "P1", name: "様式パターン①", docKind: "mixed", hint: null }],
      prompts: { classify: { promptId: "p-1", body: "分類の指示文" } },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "prompts" in parsed.data).toBe(false);
  });

  it("⚠ traceId は 16 進 (W3C と同じ形。Mastra の TracingOptions に渡す)", () => {
    expect(
      docExtractRequestSchema.safeParse({ ...base, tracingOptions: { traceId: "ではない" } })
        .success,
    ).toBe(false);
    expect(
      docExtractRequestSchema.safeParse({
        ...base,
        tracingOptions: { traceId: "0123456789abcdef0123456789abcdef" },
      }).success,
    ).toBe(true);
  });
});

describe("purchaseOrderExtraction", () => {
  it("明細は 0 行でも通る (読めない帳票をでっち上げない)", () => {
    expect(purchaseOrderExtraction.safeParse(po).success).toBe(true);
  });
});

describe("specSheetExtraction", () => {
  it("石は 0 個でも通る", () => {
    expect(specSheetExtraction.safeParse(sheet).success).toBe(true);
  });

  it("⚠ 代表の図が見つからなければ空の配列 (当てずっぽうの座標を返させない)", () => {
    expect(specSheetExtraction.safeParse({ ...sheet, pictures: [] }).success).toBe(true);
  });

  /**
   * ⚠ 器は**配列のまま**にしてある。
   * ⚠⚠ 文面が「いちばん左上の 1 つ」を選ばせているので、**ふつうは 1 要素**。
   *   複数に戻すのは文面を戻すだけでよい — **契約は単数にしない**
   *   (単数にすると web の `order_sheet_line_photos` / `pictureIndex` / R2 の鍵まで巻き戻る)。
   */
  it("代表の図は複数あってよい (器は配列のまま)", () => {
    const box = { page: 2, x: 0.1, y: 0.6, width: 0.1, height: 0.06, confidence: 60 };
    const parsed = specSheetExtraction.safeParse({
      ...sheet,
      pictures: [
        { ...box, labelQuote: "完成イメージ" },
        { ...box, x: 0.4, labelQuote: "完成イメージ" },
      ],
    });
    expect(parsed.success && parsed.data.pictures).toHaveLength(2);
  });

  /**
   * ⚠⚠ **`.default([])` にしない (必須のまま)。** 省ける形にすると、モデルが
   *   欄ごと返さない実行が出る (区分の欄で実測した罠と同じ)。
   */
  /**
   * ⚠⚠ **下部のメモも省ける形にしない。** null = ノードが走っていない、
   *   走ってメモが無かったら各欄が null。
   */
  it("⚠⚠ 下部のメモの欄ごと省くのは通さない", () => {
    const { specNote: _dropped, ...withoutNote } = sheet;
    expect(specSheetExtraction.safeParse(withoutNote).success).toBe(false);
    const note = {
      sizeText: empty,
      stoneText: empty,
      description2: empty,
      description3: empty,
      description4: empty,
    };
    expect(specSheetExtraction.safeParse({ ...sheet, specNote: note }).success).toBe(true);
    // ⚠ まとまりの中の欄も省かせない。
    const { stoneText: _stone, ...withoutStone } = note;
    expect(specSheetExtraction.safeParse({ ...sheet, specNote: withoutStone }).success).toBe(
      false,
    );
  });

  it("⚠⚠ 代表の図の欄ごと省くのは通さない", () => {
    const { pictures: _dropped, ...withoutPictures } = sheet;
    expect(specSheetExtraction.safeParse(withoutPictures).success).toBe(false);
  });

  it("⚠⚠ 枠の数の範囲は zod で縛らない (外れ値で読み取りごと落とさない)", () => {
    // 範囲の判断は lib/picture-box.ts の usableBox が受け取ってから行う。
    const parsed = specSheetExtraction.safeParse({
      ...sheet,
      pictures: [
        { page: 2, x: -0.2, y: 0.1, width: 3, height: 0.2, confidence: 40, labelQuote: null },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
