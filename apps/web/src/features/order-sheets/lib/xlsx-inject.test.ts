import { describe, expect, it } from "vitest";
import {
  CellRefCollision,
  excelSerial,
  injectCells,
  injectCellsByRef,
  UnknownCellRef,
  UnknownToken,
} from "./xlsx-inject";

/** 雛形の一部を模したもの (書式 `s` と位置 `r` を持つ)。 */
const SHEET = `<sheetData><row r="16">
<c r="A16" s="92" t="inlineStr"><is><t>{{NO_1}}</t></is></c>
<c r="D16" s="66" t="inlineStr"><is><t>{{CODE_MASTER_1}}</t></is></c>
<c r="I16" s="57" t="inlineStr"><is><t>{{QTY_1}}</t></is></c>
<c r="K16" s="39" t="inlineStr"><is><t>{{SHIP_DATE_1}}</t></is></c>
<c r="G16" s="52" t="inlineStr"><is><t>{{STONE_1}}</t></is></c>
<c r="I28" s="60"><f>SUM(I15:I26)</f></c>
</row>
<row r="17">
<c r="D17" s="110"/>
<c r="F17" s="98"/>
</row></sheetData>`;

describe("injectCells", () => {
  it("文字列はエスケープして入れる", () => {
    const out = injectCells(SHEET, { CODE_MASTER_1: 'A&B <x> "q"' });
    expect(out).toContain("A&amp;B &lt;x&gt; &quot;q&quot;");
    expect(out).toContain('r="D16" s="66" t="inlineStr"');
  });

  it("数値は数値として入れる (合計が計算できるように)", () => {
    const out = injectCells(SHEET, { QTY_1: 5 });
    expect(out).toContain('<c r="I16" s="57"><v>5</v></c>');
  });

  it("日付はシリアル値", () => {
    const out = injectCells(SHEET, { SHIP_DATE_1: excelSerial("2099-02-01") });
    expect(out).toContain("<v>72717</v>");
  });

  it("⚠ 値が無い欄は空にする。**書式は残す**", () => {
    const out = injectCells(SHEET, { STONE_1: null });
    expect(out).toContain('<c r="G16" s="52"/>');
  });

  it("⚠ 渡さなかった目印も空になる (使わない明細の枠)", () => {
    const out = injectCells(SHEET, {});
    expect(out).not.toContain("{{");
    expect(out).toContain('<c r="A16" s="92"/>');
  });

  it("⚠ 数式には触らない (合計は Excel が計算する)", () => {
    const out = injectCells(SHEET, { QTY_1: 5 });
    expect(out).toContain("<f>SUM(I15:I26)</f>");
  });

  it("多バイト文字がそのまま残る", () => {
    const out = injectCells(SHEET, { STONE_1: "ダイヤモンド 1.0MM" });
    expect(out).toContain("ダイヤモンド 1.0MM");
  });

  it("⚠ 雛形に無い目印は例外 (綴り間違いを黙って捨てない)", () => {
    expect(() => injectCells(SHEET, { QTY_9: 1 })).toThrow(UnknownToken);
  });
});

describe("excelSerial", () => {
  it("エポックは 1899-12-30", () => {
    expect(excelSerial("1899-12-31")).toBe(1);
    expect(excelSerial("2099-02-01")).toBe(72717);
  });

  it("日付でなければ null (読めなかった欄を 0 にしない)", () => {
    expect(excelSerial("—")).toBeNull();
    expect(excelSerial("")).toBeNull();
  });
});

/**
 * ★ 継ぎ行は**目印を置かず、番地で直接**入れる。
 *
 * ⚠ 目印を 1 明細 50 個 × 12 = 600 個ぶん増やさないための分担
 *   (`order-sheet-layout.ts` の `LINE_CELLS` は値の行だけ)。
 */
describe("injectCellsByRef", () => {
  it("雛形の空セルに中身だけ入れる (書式はそのまま)", () => {
    const out = injectCellsByRef(SHEET, { F17: "POLISH", D17: "G990321" });
    // ⚠ `s` が残ること = 罫線と折り返しが雛形のままということ。
    expect(out).toContain('<c r="F17" s="98" t="inlineStr"><is><t xml:space="preserve">POLISH');
    expect(out).toContain('<c r="D17" s="110" t="inlineStr"><is><t xml:space="preserve">G990321');
  });

  it("空の値はセルを空のままにする", () => {
    const out = injectCellsByRef(SHEET, { F17: null });
    expect(out).toContain('<c r="F17" s="98"/>');
  });

  it("何も渡さなければ触らない", () => {
    expect(injectCellsByRef(SHEET, {})).toBe(SHEET);
  });

  /** ⚠ 綴り間違いを黙って捨てない (雛形にない番地に書こうとしたら落とす)。 */
  it("⚠ 雛形にない番地は落とす", () => {
    expect(() => injectCellsByRef(SHEET, { Z99: "x" })).toThrow(UnknownCellRef);
  });

  /**
   * ⚠⚠ **値の行を二重に書かせない。** 目印のあるセルを番地で上書きすると、
   *   `injectCells` が入れた値が黙って消える。
   */
  it("⚠⚠ 目印のあるセルを番地で上書きしようとしたら落とす", () => {
    expect(() => injectCellsByRef(SHEET, { D16: "x" })).toThrow(CellRefCollision);
  });
});
