import { describe, expect, it } from "vitest";
import { renderOrderSheetXlsx } from "./order-sheet-xlsx";
import { cellOf, isTextCell, sheetXml } from "./xlsx-read";

/**
 * ★★ **出した xlsx を読み返して、実物と同じ番地に同じ文字が入っていることを確かめる。**
 *
 * ⚠⚠ これが「見出しもモデルに入れて xlsx を完全再現する」の**合格条件**。
 *   ほかのテストは「入力の形」を見ているが、ここだけが**出力の xlsx そのもの**を見る。
 * ⚠ 雛形に印字は 1 つも残っていない（`order-sheet-template.test.ts` が担保）。
 *   つまりここに出る見出しは**すべて `SHEET_HEADINGS` から入った**もの。
 */
describe("★★ 出した xlsx を読み返す", () => {
  it("見出し・ヘッダ・明細が番地どおりに入る", async () => {
    // 架空の 2 件。
    const lines: { cells: Record<string, string> }[] = [
      {
        cells: {
          D16: "2099-05-S001",
          F16: "CASTING SV950",
          I16: "5",
          J16: "PCS",
          L16: "XX 0001",
          F17: "POLISH",
        },
      },
      {
        cells: {
          D22: "2099-12-S002",
          F22: "CASTING SV950",
          H22: "#10",
          I22: "1",
          J22: "PCS",
          L22: "XX 0002",
        },
      },
    ];
    const refInput = {
      partnerName: "顧客A",
      issuedOn: "2026-09-23",
      header: { J5: null, J7: "F10000001", D12: null, F12: null } as Record<string, string | null>,
      lines,
    };
    const xml = await sheetXml(await renderOrderSheetXlsx(refInput));

    // ① 見出し (雛形ではなくコードから入る)
    expect(cellOf(xml, "B2")).toBe("PRODUCTION PLAN");
    expect(cellOf(xml, "F2")).toBe("ORDER SHEET  ");
    expect(cellOf(xml, "A14")).toBe("No.");
    expect(cellOf(xml, "K14")).toBe("SHIP DATE ");
    expect(cellOf(xml, "L14")).toBe("REMARK");
    expect(cellOf(xml, "B10")).toBe("FINAL QC+REPAIR");
    expect(cellOf(xml, "H7")).toBe("PCS");
    // ② ヘッダ (接頭辞込み) と派生
    expect(cellOf(xml, "J7")).toBe("Customer PO : F10000001");
    expect(cellOf(xml, "A12")).toBe("CUSTOMER: 顧客A");
    expect(cellOf(xml, "F5")).toBe("顧客A");
    // ⚠ DATE は実例の書き方（`d/m/yy`）。画面も同じ文字を出す。
    expect(cellOf(xml, "J12")).toBe("DATE : 23/9/26");
    // ③ 明細の値の行と継ぎ行
    expect(cellOf(xml, "D16")).toBe("2099-05-S001");
    expect(cellOf(xml, "L16")).toBe("XX 0001");
    expect(cellOf(xml, "F17")).toBe("POLISH");
    expect(cellOf(xml, "D22")).toBe("2099-12-S002");
    expect(cellOf(xml, "L22")).toBe("XX 0002");
    // ④ 数量は**数値**（文字列だと SUM が 0 になる）
    expect(cellOf(xml, "I16")).toBe("5");
    expect(xml).toMatch(/<c r="I16"(?![^>]*t="inlineStr")/);
    // ⑤ 合計の行の単位。⚠⚠ **明細 2 件なら実物と同じ `J28`**（以前は `J88` 固定）
    expect(cellOf(xml, "J28")).toBe("PCS");
    expect(cellOf(xml, "J88")).toBeNull();
    // ⑥ 合計の数式が生きていて、キャッシュ値も同じ数（5 + 1）。実物は `SUM(I15:I26)` / `SUM(I28)`
    expect(xml).toContain('<c r="I28" s="60"><f>SUM(I15:I26)</f><v>6</v></c>');
    expect(xml).toContain('<c r="G7" s="117"><f>SUM(I28)</f><v>6</v></c>');
    // ⑦ 空き行（27）は空、枠は 2 個だけ（行は 30 で終わる）
    expect(xml).toMatch(/<row r="27" spans="1:12">(<c r="[A-L]27" s="\d+"\/>)+<\/row>/);
    expect(xml).not.toContain('<row r="31"');
    // ⑧ 目印が 1 つも残っていない
    expect(xml).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  /**
   * ★★ 工程表（`C4:E10`）が xlsx に出る。**人が打つセルになった。**
   *
   * ⚠⚠ **このテストが守っているのは `toXlsxInput()` のほう。** `buildCellRefs()` は
   *   `HEADER_CELLS` を回す汎用だが、その入口の `toXlsxInput()` は
   *   `J5` / `J7` / `D12` / `F12` の 4 つを**べた書き**していた。
   *   直し忘れると「値は `cells_json` に保存され、リロードしても残るのに、
   *   **xlsx にだけ出ない**」という壊れ方をする（例外も警告も出ない）。
   * ⚠⚠ **値は文字のまま入ること**（`t="inlineStr"`）。日付のシリアル値に寄せると、
   *   人が書いた自由な文字を黙って日付と解釈してしまう。
   */
  it("★★ 工程表の値が C4:E10 に文字のまま入る", async () => {
    const lines: { cells: Record<string, string> }[] = [];
    const xml = await sheetXml(
      await renderOrderSheetXlsx({
        partnerName: null,
        issuedOn: "2026-09-23",
        header: {
          C4: "10/1",
          D4: "10/3",
          E4: "3",
          C10: "10月上旬",
          E10: "2",
        } as Record<string, string | null>,
        lines,
      }),
    );

    expect(cellOf(xml, "C4")).toBe("10/1");
    expect(cellOf(xml, "D4")).toBe("10/3");
    expect(cellOf(xml, "E4")).toBe("3");
    // ⚠ 日付に見えない文字もそのまま通る（雛形の書式 `dd/mm/yy;@` の `;@` が効く）。
    expect(cellOf(xml, "C10")).toBe("10月上旬");
    expect(cellOf(xml, "E10")).toBe("2");
    // ⚠ **数値に寄せない**（`excelSerial()` を通すと自由な文字が壊れる）。
    expect(xml).toMatch(/<c r="C4"[^>]*t="inlineStr"/);
    // ⚠ 打っていないセルは空のまま（罫線の書式は残る）。
    expect(cellOf(xml, "C5")).toBeNull();
    expect(xml).toMatch(/<c r="C5" s="17"\/>/);
    // ⚠ 工程表の見出しと工程名は今までどおり出る（工程表の値と喧嘩しない）。
    expect(cellOf(xml, "C3")).toBe("Start");
    expect(cellOf(xml, "B4")).toBe("WAX");
  });
});

/**
 * ★★ 明細 12 件（上限）でも崩れない。合計は `I88`、数は全部の QTY の和。
 * ⚠ 数に読めない QTY は `SUM` と同じく数えない（キャッシュ値と Excel の計算を揃える）。
 */
describe("★★ 明細の数ごとの xlsx", () => {
  it("明細 12 件: 合計は I88 = SUM(I15:I86)、数は QTY の和", async () => {
    const lines = Array.from({ length: 12 }, (_u, index) => ({
      cells: { [`I${16 + index * 6}`]: index === 11 ? "読めない" : String(index + 1) } as Record<
        string,
        string
      >,
    }));
    const xml = await sheetXml(
      await renderOrderSheetXlsx({ partnerName: null, issuedOn: "2026-09-26", header: {}, lines }),
    );
    // 1 + 2 + … + 11 = 66（12 件目は数に読めない）
    expect(xml).toContain('<c r="I88" s="60"><f>SUM(I15:I86)</f><v>66</v></c>');
    expect(xml).toContain('<c r="G7" s="117"><f>SUM(I88)</f><v>66</v></c>');
    expect(cellOf(xml, "J88")).toBe("PCS");
    expect(xml).toContain('<dimension ref="A1:L90"/>');
  });

  it("明細 0 件: 枠 1 個・合計 I22 は 0", async () => {
    const xml = await sheetXml(
      await renderOrderSheetXlsx({
        partnerName: null,
        issuedOn: "2026-09-26",
        header: {},
        lines: [],
      }),
    );
    expect(xml).toContain('<c r="I22" s="60"><f>SUM(I15:I20)</f><v>0</v></c>');
    expect(cellOf(xml, "J22")).toBe("PCS");
    expect(xml).not.toContain('<row r="25"');
  });
});

/**
 * ★★ **画面に出ている文字が、そのまま xlsx に入る。**
 *
 * ⚠⚠ 日本語・タイ語が落ちる経路が無いことを確かめる。
 *   英数字に絞るコードは無く、日本語・タイ語はどのセルにもそのまま入る。
 * ⚠⚠ 以前は、描き出しのときにだけ文字が変わるセルがあった:
 *   QTY（数に読めない文字は消えた）と SHIP DATE（`YYYY-MM-DD` 以外は消え、読めた日付も
 *   `2099/2/1 0:00:00` に見えた）。いまは**どちらも打った文字のまま**。
 * ⚠ ヘッダは紙の印字の接頭辞（`SHIP : `）と値を 1 つのセルに入れる。画面も入力欄の前に
 *   同じ接頭辞を出すので、見える文字は同じ。
 */
describe("★★ 画面の文字がそのまま xlsx に入る", () => {
  it("日本語・タイ語・自由な日付・数に読めない QTY が、打った文字のまま入る", async () => {
    const xml = await sheetXml(
      await renderOrderSheetXlsx({
        partnerName: null,
        issuedOn: "2026-09-26",
        header: { J5: "10月上旬", J7: "F10009999", D12: "社内 PO", F12: "ใบสั่ง 1" } as Record<
          string,
          string | null
        >,
        lines: [
          {
            cells: {
              B16: "コード-1",
              C16: "900301",
              D16: "2099-05-S001",
              F16: "鋳造 SV950",
              F17: "磨き POLISH",
              F18: "ชุบ K18PG/P +RH",
              F20: "ロゴ 0°C SILVER",
              G16: "(ダイヤモンド) STONE-A RD 1.0 MM *3 PCS",
              H16: "11号",
              I16: "3個",
              J16: "本",
              K16: "1/2/99",
              L16: "至急 ด่วน",
            },
          },
          { cells: { I22: "2", K22: "2099-02-01", F22: "キャスト" } },
        ],
      }),
    );

    // 明細の値の行（目印の道）と継ぎ行（番地の道）。どちらも文字を変えない。
    const expected: Record<string, string> = {
      B16: "コード-1",
      C16: "900301",
      D16: "2099-05-S001",
      F16: "鋳造 SV950",
      F17: "磨き POLISH",
      F18: "ชุบ K18PG/P +RH",
      F20: "ロゴ 0°C SILVER",
      G16: "(ダイヤモンド) STONE-A RD 1.0 MM *3 PCS",
      H16: "11号",
      I16: "3個",
      J16: "本",
      K16: "1/2/99",
      L16: "至急 ด่วน",
      F22: "キャスト",
      I22: "2",
      K22: "2099-02-01",
      // ヘッダは印字の接頭辞 ＋ 打った文字（画面も同じ並びで出す）。
      J5: "SHIP : 10月上旬",
      J7: "Customer PO : F10009999",
      D12: "PO: 社内 PO",
      F12: "SO: ใบสั่ง 1",
      J12: "DATE : 26/9/26",
    };
    for (const [ref, text] of Object.entries(expected)) {
      expect({ ref, text: cellOf(xml, ref) }).toEqual({ ref, text });
    }

    // ⚠ QTY は数に読めるときだけ数値のセル（合計の SUM が数える）。読めない文字は文字のセル。
    expect(isTextCell(xml, "I16")).toBe(true);
    expect(isTextCell(xml, "I22")).toBe(false);
    // ⚠ SHIP DATE は文字のセル（シリアル値にしない）。
    expect(isTextCell(xml, "K16")).toBe(true);
    expect(isTextCell(xml, "K22")).toBe(true);
    // 合計は数に読める QTY だけ（Excel の SUM と同じ）。
    expect(xml).toContain('<c r="I28" s="60"><f>SUM(I15:I26)</f><v>2</v></c>');
  });
});
