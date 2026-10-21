import { describe, expect, it } from "vitest";
import { fitSheetToLines, fitWorkbookToLines, pageBreakRowsOf } from "./order-sheet-fit";
import {
  BLOCK_COUNT,
  BLOCK_ROWS,
  FIRST_BLOCK_ROW,
  LINE_CELLS,
  lastBlockRowOf,
  lineToken,
  PLAN_CELLS,
  PRINT_TITLE_ROWS,
  SHEET_MERGES,
  sheetHeadingsOf,
  TEMPLATE_TOTAL_ROW,
  totalRowOf,
} from "./order-sheet-layout";
import { ORDER_SHEET_TEMPLATE } from "./order-sheet-template";

/**
 * ★★ **雛形は実物から作る。固有名詞が残っていないことを機械で確かめる。**
 *   目で見るだけでは必ず漏れるし、雛形はコミットされる。
 */
const sheet = ORDER_SHEET_TEMPLATE["xl/worksheets/sheet1.xml"]!;

/**
 * ★ 禁止語（取引先の名前・略号・実在の番号）。一覧そのものが取引先を名指しするので
 *   ソースには書かず、`assets/banned-terms.txt`（1 行 1 語）から読む。
 *   ⚠ この一覧は手元に置いたときだけ使う（リポジトリには含まない）。
 * ⚠ `node:fs` は apps/web/src では使えないので `import.meta.glob`（無ければ空）。
 */
const BANNED_TERMS = Object.values(
  import.meta.glob<string>("../../../../../../assets/banned-terms.txt", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)
  .flatMap((text) => text.split(/\r?\n/))
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

describe("雛形のパーツ", () => {
  it("画像・図形・共有文字列を持たない", () => {
    const paths = Object.keys(ORDER_SHEET_TEMPLATE);
    expect(paths.some((path) => path.startsWith("xl/media/"))).toBe(false);
    expect(paths.some((path) => path.includes("drawing"))).toBe(false);
    expect(paths).not.toContain("xl/sharedStrings.xml");
    // ⚠ 実物の画像は 3.4MB。載せるとバンドルが太るだけで、Picture は人が埋める欄。
    expect(paths).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/theme/theme1.xml",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("全セルがインライン文字列 (共有文字列表を引かない)", () => {
    expect(sheet).not.toContain('t="s"');
  });

  it("開いたときに合計を計算させる", () => {
    expect(ORDER_SHEET_TEMPLATE["xl/workbook.xml"]).toContain('fullCalcOnLoad="1"');
  });

  /** ⚠ 改ページの見積もりは、2 ページ目以降の繰り返しの見出しの高さを先に引いている。 */
  it("★ 繰り返して刷る行は PRINT_TITLE_ROWS", () => {
    expect(ORDER_SHEET_TEMPLATE["xl/workbook.xml"]).toMatch(
      new RegExp(
        `name="_xlnm\\.Print_Titles"[^>]*>[^<]*!\\$${PRINT_TITLE_ROWS.first}:\\$${PRINT_TITLE_ROWS.last}<`,
      ),
    );
  });
});

describe("★ 雛形に実物の印字が残っていないこと", () => {
  /**
   * ⚠⚠ **「見出しも残っていないこと」まで見る。**
   *   見出しの正は `SHEET_HEADINGS` に移り、描き出しのときに番地で入る。
   *   通ってよい `<t>` は**目印 (`{{…}}`) だけ**。
   *   **ここを緩めると、見出しの正が「雛形」と「コード」の 2 か所に戻る。**
   */
  it("★★ 残っている文字は目印だけ (見出しもコードが持つ)", () => {
    const leaked: string[] = [];
    for (const m of sheet.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
      const text = m[1]!.trim();
      if (text === "") continue;
      if (/^\{\{[A-Z0-9_]+\}\}$/.test(text)) continue;
      leaked.push(text);
    }
    expect(leaked).toEqual([]);
  });

  /**
   * ⚠⚠ **見出しを入れる番地が雛形に実在すること。** `injectCellsByRef` は
   *   雛形に無い番地を `UnknownCellRef` で弾くので、ここが欠けると
   *   **xlsx の描き出しが丸ごと落ちる**。
   */
  it("★★ 見出しとヘッダの番地がセルとして実在する", () => {
    const present = new Set([...sheet.matchAll(/<c r="([A-L]+\d+)"/g)].map((m) => m[1]));
    // ⚠ 合計の行の `PCS` は明細の数で動く。雛形（12 枠）では `J88`。
    for (const heading of sheetHeadingsOf(BLOCK_COUNT)) {
      expect(present.has(heading.cell), heading.cell).toBe(true);
    }
    // ⚠ 取引先名 (F5) は雛形では空。**セルは残っている**（結合の都合）。
    expect(present.has("F5")).toBe(true);
  });

  it("⚠ 工程表の日付 (数値セル) も残っていない", () => {
    // 実物の日付はシリアル値なので、文字の検査をすり抜ける。
    // 4..10 行目の C/D/E 列に値が無いことを見る。
    for (const row of [4, 7, 10]) {
      for (const column of ["C", "D", "E"]) {
        const cell = new RegExp(`<c r="${column}${row}"[^>]*?(/>|>[\\s\\S]*?</c>)`).exec(sheet);
        expect(cell?.[0] ?? "").not.toMatch(/<v>\d/);
      }
    }
  });
});

/**
 * ★★ **セルの外にも持ち主の手がかりを残さない**。
 *   `<t>` の検査はセルしか見ないので、保存場所（`x15ac:absPath`）・SO 番号のシート名・
 *   文書の ID・帳票番号のフッタが素通りしていた。雛形を作るときに落としてある。
 */
describe("★★ 雛形に元のファイルの手がかりが残っていないこと", () => {
  const all = Object.values(ORDER_SHEET_TEMPLATE).join("\n");

  it("保存場所・文書の ID・uid を持たない", () => {
    expect(all).not.toContain("absPath");
    expect(all).not.toContain("documentId");
    expect(all).not.toMatch(/\sxr\d*:uid/);
  });

  it("シート名は ORDER（印刷範囲の参照も）", () => {
    const workbook = ORDER_SHEET_TEMPLATE["xl/workbook.xml"]!;
    expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["ORDER"]);
    const refs = [...workbook.matchAll(/<definedName\b[^>]*>([^<!]*)!/g)].map((m) => m[1]);
    expect(refs).toEqual(["ORDER", "ORDER"]);
  });

  it("フッタに文字が無く、タイ文字も無い", () => {
    expect(sheet).not.toMatch(/<oddFooter>[^<]/);
    expect(all).not.toMatch(/[\u0E00-\u0E7F]/);
  });

  it.skipIf(BANNED_TERMS.length === 0)(
    `禁止語が 1 つも無い${BANNED_TERMS.length === 0 ? "（assets/banned-terms.txt が無いので飛ばす）" : ""}`,
    () => {
      for (const term of BANNED_TERMS) expect(all.includes(term), term).toBe(false);
    },
  );
});

describe("目印", () => {
  it("明細の枠が BLOCK_COUNT 個ある", () => {
    for (const spec of LINE_CELLS) {
      expect(sheet).toContain(`{{${lineToken(spec.key, 0)}}}`);
      expect(sheet).toContain(`{{${lineToken(spec.key, BLOCK_COUNT - 1)}}}`);
    }
    expect(sheet).not.toContain(`{{${lineToken("qty", BLOCK_COUNT)}}}`);
  });

  /**
   * ⚠⚠ **ヘッダの目印は 消した。** ヘッダも見出しも派生も
   *   `injectCellsByRef` が番地で入れる。**目印が残るのは明細の値の行だけ。**
   */
  it("★★ 目印は明細の値の行のぶんだけ", () => {
    const tokens = [...sheet.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]!);
    // 11 欄 × 12 枠。⚠ ヘッダの 6 つは入らない。
    expect(tokens).toHaveLength(132);
    for (const gone of ["SHIP", "CUSTOMER_PO", "CUSTOMER", "PO_NO", "SO_NO", "DATE"]) {
      expect(sheet).not.toContain(`{{${gone}}}`);
    }
  });

  /**
   * ★★ **結合セルの正はコード（`SHEET_MERGES`）で、雛形とここで突き合わせる。**
   *
   * ⚠⚠ 以前は**数（`count="7"`）しか見ていなかった。** 数が合っていても
   *   どれかの範囲が動けば素通りするうえ、**コードは結合を 1 つも知らなかった**ので、
   *   画面が格子を組むときに写しを作るしかなかった。いまは
   *   雛形 → `SHEET_MERGES` → 画面側の写し が機械で繋がっている。
   * ⚠ 雛形の並びは順不同（`J5:L6, G7:G8, …`）なので**揃えてから比べる**。
   */
  it("★★ 結合セルが SHEET_MERGES と 1 対 1", () => {
    const block = /<mergeCells count="(\d+)">([\s\S]*?)<\/mergeCells>/.exec(sheet);
    expect(block).not.toBeNull();
    const refs = [...block![2]!.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]!);

    expect(Number(block![1])).toBe(SHEET_MERGES.length);
    expect([...refs].sort()).toEqual([...SHEET_MERGES].sort());
  });

  /**
   * ★★ 工程表のセルが雛形に**在る**こと。無いと `injectCellsByRef` が
   *   `UnknownCellRef` で落ち、**xlsx の書き出しごと死ぬ**。
   * ⚠ かつ**空である**こと（実物の日程はシリアル値なので、文字の検査を素通りする）。
   */
  it("★★ 工程表のセルは雛形に在って、空", () => {
    for (const ref of PLAN_CELLS) {
      // ⚠ 自閉じ (`<c .../>`) を**先に丸ごと**試すこと。`(?:/>|>…)` だと `[^>]*` が
      //   `/` まで食ってしまい、次の `</c>` まで飲み込む（実際に起きた）。
      const cell = new RegExp(
        `<c r="${ref}"[^>]*/>|<c r="${ref}"[^>]*>[\\s\\S]*?</c>`,
      ).exec(sheet);
      expect(cell, `雛形に ${ref} が無い`).not.toBeNull();
      expect(cell![0], `${ref} に値が残っている`).not.toMatch(/<v>|<t[ >]/);
    }
  });

  it("合計は枠の全部を数える", () => {
    expect(sheet).toMatch(/<f>SUM\(I15:I\d+\)<\/f>/);
  });
});

/** 行を `r` → XML で引く。 */
function rowsOf(xml: string): Map<number, string> {
  const rows = new Map<number, string>();
  for (const m of xml.matchAll(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g)) {
    rows.set(Number(/<row\b[^>]*?\sr="(\d+)"/.exec(m[0])![1]), m[0]);
  }
  return rows;
}

/** 行番号を消した形（書式と罫線だけを比べるため）。 */
function shapeOf(rowXml: string): string {
  return rowXml.replace(/\sr="[A-Z]*\d+"/g, "").replace(/<f>[^<]*<\/f>(<v>[^<]*<\/v>)?/g, "");
}

/**
 * ★★ **明細の数だけの枠に削る**。雛形は 12 枠のまま、描き出しで後ろを落とす。
 *
 * ⚠⚠ **実物（明細 2 件）が正解。** 「枠 15〜26 → 空き行 27 → 合計 28 (`SUM(I15:I26)` と
 *   `PCS`)」、dimension は `A1:L30`、印刷範囲は `$A$1:$L$31`。
 * ⚠⚠ 以前は枠はいつも 12 個で、印刷範囲は実物の `$A$1:$L$31` のままだった。
 *   12 枠でも**行 31 より下が刷られず**、合計 `I88` は紙に出なかった（「I88 の挙動」）。
 */
describe("★★ 明細の数ごとの形（描き出しで削る）", () => {
  const counts = [0, 1, 2, 5, 6, 12];

  it.each(counts)("明細 %i 件: 枠・空き行・合計の並びと数式", (lines) => {
    const fitted = fitSheetToLines(sheet, lines, 7);
    const rows = rowsOf(fitted);
    const total = totalRowOf(lines);
    const last = lastBlockRowOf(lines);

    // ① 枠の行は明細の数だけ（0 件でも 1 枠）。落とした枠の目印は残らない。
    const blocks = Math.max(1, lines);
    for (let index = 0; index < BLOCK_COUNT; index++) {
      const token = `{{${lineToken("qty", index)}}}`;
      expect(fitted.includes(token), token).toBe(index < blocks);
    }
    // ② 行番号は 1..合計+2 で抜けも重なりも無い（実物は 1..30）。
    expect([...rows.keys()]).toEqual(Array.from({ length: total + 2 }, (_u, i) => i + 1));
    // ③ 合計の行と G7 の数式。キャッシュ値は渡した数。
    expect(rows.get(total)).toContain(`<c r="I${total}" s="60"><f>SUM(I15:I${last})</f><v>7</v></c>`);
    expect(fitted).toContain(`<c r="G7" s="117"><f>SUM(I${total})</f><v>7</v></c>`);
    // ④ 罫線と書式: 空き行・合計の行・その下の行は雛形の 87..90 と同じ形。
    const template = rowsOf(sheet);
    for (let offset = -1; offset <= 2; offset++) {
      expect(shapeOf(rows.get(total + offset)!)).toBe(
        shapeOf(template.get(TEMPLATE_TOTAL_ROW + offset)!),
      );
    }
    // ⑤ 結合は動かない（行 2〜8 にしか無い）。dimension は実在する最後の行まで。
    const merges = [...fitted.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]!);
    expect(merges.sort()).toEqual([...SHEET_MERGES].sort());
    expect(fitted).toContain(`<dimension ref="A1:L${total + 2}"/>`);
  });

  it("★★ 明細 2 件は実物と同じ番地（合計 I28 = SUM(I15:I26)、印刷範囲 $L$31）", () => {
    const fitted = fitSheetToLines(sheet, 2, 6);
    expect(fitted).toContain('<c r="I28" s="60"><f>SUM(I15:I26)</f><v>6</v></c>');
    expect(fitted).toContain('<c r="G7" s="117"><f>SUM(I28)</f><v>6</v></c>');
    expect(fitted).toContain('<dimension ref="A1:L30"/>');
    // ⚠ 雛形に残っていた実物の改ページ `brk id=34` は消える（1 ページに収まる）。
    expect(fitted).not.toContain("<rowBreaks");
    expect(fitWorkbookToLines(ORDER_SHEET_TEMPLATE["xl/workbook.xml"]!, 2)).toContain(
      "!$A$1:$L$31</definedName>",
    );
  });

  it("⚠ 合計を渡さなければ <v> を書かない", () => {
    expect(fitSheetToLines(sheet, 2, null)).toContain(
      '<c r="I28" s="60"><f>SUM(I15:I26)</f></c>',
    );
  });

  it.each(counts)("明細 %i 件: 印刷範囲は合計の 3 行下まで", (lines) => {
    const workbook = fitWorkbookToLines(ORDER_SHEET_TEMPLATE["xl/workbook.xml"]!, lines);
    expect(workbook).toContain(`!$A$1:$L$${totalRowOf(lines) + 3}</definedName>`);
    // ⚠ 繰り返しの見出しは触らない。
    expect(workbook).toContain("!$12:$14</definedName>");
  });

  /**
   * ★★ 改ページは**枠の境目にだけ**入る（明細 1 件の 6 行を 2 ページに割らない）。
   *
   * ⚠ 値は雛形の行の高さと用紙（A4 横・縮尺 27%・余白）からの見積もり。
   *   LibreOffice で PDF にして、12 件で 3 ページ（4 枠 / 6 枠 / 2 枠 + 合計）を確かめた。
   */
  it.each([
    [0, []],
    [1, []],
    [2, []],
    [4, []],
    [5, [38]],
    [10, [38]],
    [11, [38, 74]],
    [12, [38, 74]],
  ])("明細 %i 件: 改ページは %j", (lines, expected) => {
    const fitted = fitSheetToLines(sheet, lines, 0);
    expect(pageBreakRowsOf(fitted, lines)).toEqual(expected);
    const tags = [...fitted.matchAll(/<brk id="(\d+)" max="11" man="1"\/>/g)].map((m) =>
      Number(m[1]),
    );
    expect(tags).toEqual(expected);
    for (const row of tags) {
      // 枠の末尾（= 次の枠の直前）か、最後の枠の末尾。
      expect((row - (FIRST_BLOCK_ROW - 1)) % BLOCK_ROWS, `brk ${row}`).toBe(0);
      expect(row).toBeLessThanOrEqual(lastBlockRowOf(lines));
    }
  });

  it("⚠ 枠に収まらない数は削らずに例外", () => {
    expect(() => fitSheetToLines(sheet, BLOCK_COUNT + 1, 0)).toThrow();
  });
});
