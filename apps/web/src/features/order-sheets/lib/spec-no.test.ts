import { describe, expect, it } from "vitest";
import { applyAiLinks, matchBySpecNo, normalizeSpecNo } from "./spec-no";

describe("normalizeSpecNo", () => {
  it("大小文字・空白・区切りの揺れを吸収する", () => {
    expect(normalizeSpecNo("mfg-000123")).toBe("MFG000123");
    expect(normalizeSpecNo("MFG 000123")).toBe("MFG000123");
    expect(normalizeSpecNo("MFG_000123")).toBe("MFG000123");
    expect(normalizeSpecNo(" MFG-000123 ")).toBe("MFG000123");
  });

  it("全角で印字されていても同じ番号として扱う", () => {
    expect(normalizeSpecNo("ＭＦＧ－０００１２３")).toBe("MFG000123");
  });

  it("空や未入力は null", () => {
    expect(normalizeSpecNo(null)).toBeNull();
    expect(normalizeSpecNo("")).toBeNull();
    expect(normalizeSpecNo("  -  ")).toBeNull();
  });
});

describe("matchBySpecNo", () => {
  const revisions = [
    { revisionRequestId: "rev-1", specNo: "MFG-000123" },
    { revisionRequestId: "rev-2", specNo: "ＭＦＧ－０００１２４" },
  ];

  it("製造番号で結びつく (書き方が揺れていても)", () => {
    const { matches } = matchBySpecNo({
      lines: [
        { lineId: "l1", rawModelNo: "mfg 000123" },
        { lineId: "l2", rawModelNo: "MFG-000124" },
      ],
      revisions,
    });
    expect(matches).toEqual([
      { lineId: "l1", revisionRequestId: "rev-1", matchedBy: "spec_no" },
      { lineId: "l2", revisionRequestId: "rev-2", matchedBy: "spec_no" },
    ]);
  });

  it("⚠ 結びつかなかった明細も必ず行が返る (空のまま先へ進める)", () => {
    const { matches } = matchBySpecNo({
      lines: [
        { lineId: "l1", rawModelNo: "MFG-999999" },
        { lineId: "l2", rawModelNo: null },
      ],
      revisions,
    });
    expect(matches).toEqual([
      { lineId: "l1", revisionRequestId: null, matchedBy: null },
      { lineId: "l2", revisionRequestId: null, matchedBy: null },
    ]);
  });

  it("どの明細にも付かなかった依頼書を返す", () => {
    const { unmatchedRevisionIds } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: "MFG-000123" }],
      revisions,
    });
    expect(unmatchedRevisionIds).toEqual(["rev-2"]);
  });

  it("同じ製造番号の明細が複数あれば、どれも同じ依頼書に付く", () => {
    const { matches } = matchBySpecNo({
      lines: [
        { lineId: "l1", rawModelNo: "MFG-000123" },
        { lineId: "l2", rawModelNo: "MFG-000123" },
      ],
      revisions,
    });
    expect(matches.every((m) => m.revisionRequestId === "rev-1")).toBe(true);
  });

  it("番号の無い依頼書は鍵にしない", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: null }],
      revisions: [{ revisionRequestId: "rev-x", specNo: null }],
    });
    expect(matches[0]?.revisionRequestId).toBeNull();
  });
});

describe("★ 年の桁が違う帳票どうしを結ぶ", () => {
  // ⚠⚠ 実物では **発注書が 2 桁年 / 依頼書が 4 桁年**で印字されている。
  //   正規化しただけでは一致しないので、鍵を複数作って交わりで判定する。
  it("発注書の 2 桁年と依頼書の 4 桁年が結びつく", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: "99-12-S002" }],
      revisions: [{ revisionRequestId: "rev-1", specNo: "2099 - 12 - S002" }],
    });
    expect(matches[0]).toMatchObject({ revisionRequestId: "rev-1", matchedBy: "spec_no" });
  });

  it("逆 (発注書が 4 桁年 / 依頼書が 2 桁年) でも結びつく", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: "2099-12-S002" }],
      revisions: [{ revisionRequestId: "rev-1", specNo: "99-12-S002" }],
    });
    expect(matches[0]?.revisionRequestId).toBe("rev-1");
  });

  it("⚠ 2 桁を 4 桁に伸ばさない (世紀を当てずっぽうで決めない)", () => {
    // 20-12-S002 は 2020 年とも 1920 年とも読めるので、4 桁の別番号には結ばない。
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: "20-12-S002" }],
      revisions: [{ revisionRequestId: "rev-1", specNo: "2019-12-S002" }],
    });
    expect(matches[0]?.revisionRequestId).toBeNull();
  });

  it("年の形をしていない番号は縮めない", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: "MFG-000123" }],
      revisions: [{ revisionRequestId: "rev-1", specNo: "000123" }],
    });
    expect(matches[0]?.revisionRequestId).toBeNull();
  });
});

describe("★ 品名での予備の突き合わせ", () => {
  // ⚠ 実物には**製造番号が印字されていない明細**がある。その行は品名でしか結べない。
  it("製造番号が無い明細は品名で結ぶ", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: null, rawProductName: "900000000001" }],
      revisions: [
        { revisionRequestId: "rev-1", specNo: "2099-12-S002", productName: "90000 000 0001" },
      ],
    });
    expect(matches[0]).toMatchObject({ revisionRequestId: "rev-1", matchedBy: "product_name" });
  });

  it("⚠ 製造番号で結べるならそちらが勝つ", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: "2099-12-S002", rawProductName: "900000000001" }],
      revisions: [
        { revisionRequestId: "rev-other", specNo: null, productName: "900000000001" },
        { revisionRequestId: "rev-1", specNo: "2099-12-S002", productName: null },
      ],
    });
    expect(matches[0]).toMatchObject({ revisionRequestId: "rev-1", matchedBy: "spec_no" });
  });

  it("⚠ 同じ品名の依頼書が 2 件あったら結ばない (でっち上げ防止)", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: null, rawProductName: "900000000001" }],
      revisions: [
        { revisionRequestId: "rev-1", specNo: null, productName: "900000000001" },
        { revisionRequestId: "rev-2", specNo: null, productName: "900000000001" },
      ],
    });
    expect(matches[0]?.revisionRequestId).toBeNull();
  });

  it("⚠ 短すぎる鍵では結ばない", () => {
    const { matches } = matchBySpecNo({
      lines: [{ lineId: "l1", rawModelNo: null, rawProductName: "A1" }],
      revisions: [{ revisionRequestId: "rev-1", specNo: null, productName: "A1" }],
    });
    expect(matches[0]?.revisionRequestId).toBeNull();
  });

  it("⚠ 品名で結ぶときは 1 対 1 (弱い鍵を広げない)", () => {
    const { matches } = matchBySpecNo({
      lines: [
        { lineId: "l1", rawModelNo: null, rawProductName: "900000000001" },
        { lineId: "l2", rawModelNo: null, rawProductName: "900000000001" },
      ],
      revisions: [{ revisionRequestId: "rev-1", specNo: null, productName: "900000000001" }],
    });
    expect(matches[0]?.revisionRequestId).toBe("rev-1");
    expect(matches[1]?.revisionRequestId).toBeNull();
  });
});

describe("applyAiLinks", () => {
  /** 規則で結べる明細と、結べない明細を 1 つずつ。 */
  const base = () =>
    matchBySpecNo({
      lines: [
        { lineId: "1", rawModelNo: "99-05-S001" },
        { lineId: "2", rawModelNo: null, rawProductName: null },
      ],
      revisions: [
        { revisionRequestId: "0", specNo: "2099-05-S001" },
        { revisionRequestId: "1", specNo: null, productName: null },
      ],
    });

  const idOf = (value: number) => String(value);

  it("規則で結べなかった明細に当てる", () => {
    const applied = applyAiLinks(
      base(),
      [{ lineNo: 2, specSheetIndex: 1, confidence: 80 }],
      idOf,
      idOf,
    );
    expect(applied.matches[1]).toEqual({
      lineId: "2",
      revisionRequestId: "1",
      matchedBy: "model",
    });
  });

  /** ⚠⚠ 実行ごとに揺れるものを正にしない。規則が結んだものは動かさない。 */
  it("⚠⚠ 既に結ばれた明細は上書きしない (規則のほうが勝つ)", () => {
    const applied = applyAiLinks(
      base(),
      [{ lineNo: 1, specSheetIndex: 1, confidence: 99 }],
      idOf,
      idOf,
    );
    expect(applied.matches[0]).toEqual({
      lineId: "1",
      revisionRequestId: "0",
      matchedBy: "spec_no",
    });
  });

  /** ⚠ 1 対 1 の縛りは web が持つ (弱い鍵で関係のない依頼書を広げない)。 */
  it("⚠ 既に使われている依頼書には当てない", () => {
    const applied = applyAiLinks(
      base(),
      [{ lineNo: 2, specSheetIndex: 0, confidence: 99 }],
      idOf,
      idOf,
    );
    expect(applied.matches[1]?.revisionRequestId).toBeNull();
  });

  it("結べなかったという答え (null) は何もしない", () => {
    const applied = applyAiLinks(
      base(),
      [{ lineNo: 2, specSheetIndex: null, confidence: 10 }],
      idOf,
      idOf,
    );
    expect(applied.matches[1]?.revisionRequestId).toBeNull();
  });

  it("知らない明細番号・依頼書の添字は捨てる", () => {
    const applied = applyAiLinks(
      base(),
      [
        { lineNo: 9, specSheetIndex: 1, confidence: 90 },
        { lineNo: 2, specSheetIndex: 9, confidence: 90 },
      ],
      (lineNo) => (lineNo <= 2 ? String(lineNo) : null),
      (index) => (index <= 1 ? String(index) : null),
    );
    expect(applied.matches[1]?.revisionRequestId).toBeNull();
  });

  it("当てた依頼書は「どの明細にも結びつかなかった」から外れる", () => {
    const before = base();
    expect(before.unmatchedRevisionIds).toContain("1");
    const applied = applyAiLinks(
      before,
      [{ lineNo: 2, specSheetIndex: 1, confidence: 80 }],
      idOf,
      idOf,
    );
    expect(applied.unmatchedRevisionIds).not.toContain("1");
  });

  it("links が空なら何も変わらない", () => {
    expect(applyAiLinks(base(), [], idOf, idOf)).toEqual(base());
  });
});
