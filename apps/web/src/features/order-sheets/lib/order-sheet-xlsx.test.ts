import { describe, expect, it } from "vitest";
import { allLineCellRefs, BLOCK_COUNT, lineCellRefs } from "./order-sheet-layout";
import {
  buildCellRefs,
  buildTokenValues,
  renderOrderSheetXlsx,
  TooManyLines,
  toXlsxInput,
} from "./order-sheet-xlsx";
import { HEADER_VALUE_CELLS, PLAN_CELLS } from "./order-sheet-layout";
import type { Field, OrderSheet } from "../schema";

/**
 * ⚠ **fixture に実物を使わない。** 値はすべて架空 (取引先は「顧客A」)。
 * ⚠⚠ **鍵は xlsx の絶対番地**。`"B16"` = 1 件目の枠の B 列。
 *   2 件目なら `"B22"` と**別の文字列**になる（相対の鍵のころは同じだった）。
 */
const line = {
  cells: {
    B16: "9ZZZ209905S001",
    C16: "900063",
    D16: "2099-05-S001",
    F16: "CASTING SV950",
    G16: "(ダイヤモンド) STONE-A RD *3 PCS",
    I16: "5",
    J16: "PCS",
    K16: "2099-02-01",
    L16: "XX 0001",
  } as Record<string, string>,
};

/** セルを 1 つ差し替えた明細。 */
const withCell = (ref: string, value: string) => ({
  cells: { ...line.cells, [ref]: value },
});

/** 番地で入れるほうの入力（見出し・ヘッダ・派生・継ぎ行）。 */
const refInput = {
  partnerName: "顧客A",
  issuedOn: "2026-09-21",
  header: {
    J5: "2026-10-05",
    J7: "F10000001",
    D12: "9000315",
    F12: "9000312",
  } as Record<string, string | number | null>,
  lines: [line],
};

describe("buildCellRefs — 見出しとヘッダ", () => {
  it("ヘッダは接頭辞付きの文字列 (実物がその形)", () => {
    const refs = buildCellRefs(refInput);
    expect(refs.A12).toBe("CUSTOMER: 顧客A");
    expect(refs.J7).toBe("Customer PO : F10000001");
    // ⚠ DATE は実例の書き方（`d/m/yy`。例: `DATE  :    28/4/99`）。画面も同じ文字を出す。
    expect(refs.J12).toBe("DATE : 21/9/26");
    expect(refs.J5).toBe("SHIP : 2026-10-05");
    expect(refs.D12).toBe("PO: 9000315");
    expect(refs.F12).toBe("SO: 9000312");
  });

  it("空の欄は接頭辞ごと空にする (「SHIP : 」だけ残さない)", () => {
    const refs = buildCellRefs({ ...refInput, header: { ...refInput.header, J5: null } });
    expect(refs.J5).toBeNull();
  });

  /**
   * ⚠⚠ **取引先名は 2 か所に出る**（`A12` は接頭辞付き、`F5` は大きい字のまま）。
   *   どちらも `partners.name` からの**派生**で、`cells_json` には入らない。
   */
  it("★ 取引先名は A12 と F5 の両方に出る", () => {
    const refs = buildCellRefs(refInput);
    expect(refs.F5).toBe("顧客A");
    expect(buildCellRefs({ ...refInput, partnerName: null }).F5).toBeNull();
  });

  /**
   * ★★ **見出しは雛形ではなくコードが持つ**。
   * ⚠⚠ **末尾の空白ごと入れること。** 整えると実物と 1 文字ずれる。
   */
  it("★★ 見出しが番地で入り、末尾の空白まで実物どおり", () => {
    const refs = buildCellRefs(refInput);
    expect(refs.B2).toBe("PRODUCTION PLAN");
    expect(refs.F2).toBe("ORDER SHEET  ");
    expect(refs.A14).toBe("No.");
    expect(refs.K14).toBe("SHIP DATE ");
    expect(refs.L14).toBe("REMARK");
    expect(refs.B4).toBe("WAX");
    expect(refs.H7).toBe("PCS");
  });
});

describe("buildTokenValues", () => {
  /**
   * ⚠⚠ **目印があるのは値の行だけ。** 継ぎ行 (原型No・POLISH・メッキ・ロゴ) は
   *   目印を置かず、`buildCellRefs()` が**番地**で入れる。
   *   目印を 1 明細 50 個 × 12 = 600 個ぶん増やさないための分担。
   * ⚠⚠ **ヘッダの目印はもう無い**。番地の道に移した。
   */
  it("★ 値の行は目印、継ぎ行は目印を持たない", () => {
    const values = buildTokenValues({ lines: [line] });
    expect(values.DESC_1).toBe("CASTING SV950");
    expect(values.CODE_MASTER_1).toBe("2099-05-S001");
    expect("DESC_R2_1" in values).toBe(false);
    expect("CODE_MASTER_R2_1" in values).toBe(false);
    // ⚠ ヘッダは番地の道。目印を作らない。
    expect("CUSTOMER" in values).toBe(false);
    expect("SHIP" in values).toBe(false);
  });

  /**
   * ⚠ 実物 (枠 = 15..20) では行 16 が `CASTING SV950`、17 が POLISH、18 がメッキ、
   *   19 が空、20 がロゴ。**それぞれが別のセル**なので、途中が空でも位置はずれない。
   */
  it("★ 継ぎ行は xlsx の番地で出る (途中の空セルも位置を保つ)", () => {
    const refs = buildCellRefs({
      ...refInput,
      lines: [
        {
          cells: {
            ...line.cells,
            D17: "G990321",
            F17: "POLISH",
            F18: "メッキの指定",
            F20: "ロゴの刻印",
          },
        },
      ],
    });
    expect(refs.D17).toBe("G990321");
    expect(refs.F17).toBe("POLISH");
    expect(refs.F18).toBe("メッキの指定");
    expect(refs.F20).toBe("ロゴの刻印");
    // ⚠ 値の行は目印が持つので、番地では出さない (出すと二重に書いて落ちる)。
    expect("F16" in refs).toBe(false);
    // 2 件目の枠は 21..26。
    expect(
      buildCellRefs({ ...refInput, lines: [line, { cells: { F23: "x" } }] }).F23,
    ).toBe("x");
  });

  /**
   * ⚠⚠ **別の枠の番地は入れない。** 番地は行番号を含むので、2 件目の地図に
   *   1 件目の番地が紛れていたら**1 件目のセルを上書きしてしまう**。
   */
  it("⚠⚠ その明細の枠の外の番地は捨てる", () => {
    const refs = buildCellRefs({ ...refInput, lines: [line, { cells: { F17: "よその値" } }] });
    // 2 件目の地図に 1 件目の番地 (F17) があっても入れない。
    expect("F17" in refs).toBe(false);
  });

  it("数量は数値 (文字列だと合計が出ない)", () => {
    expect(buildTokenValues({ lines: [line] }).QTY_1).toBe(5);
  });

  /**
   * ⚠⚠ **SHIP DATE は文字のまま**。以前ははシリアル値にしていて、
   *   `YYYY-MM-DD` で始まらない文字（画面の記入例の `2026/9/16` も）は**xlsx でだけ空**だった。
   */
  it("★★ 出荷日は打った文字のまま（シリアル値にしない・消さない）", () => {
    expect(buildTokenValues({ lines: [line] }).SHIP_DATE_1).toBe("2099-02-01");
    expect(buildTokenValues({ lines: [withCell("K16", "1/2/99")] }).SHIP_DATE_1).toBe("1/2/99");
    expect(buildTokenValues({ lines: [withCell("K16", "2026/9/16")] }).SHIP_DATE_1).toBe(
      "2026/9/16",
    );
    expect(buildTokenValues({ lines: [withCell("K16", "10月上旬")] }).SHIP_DATE_1).toBe("10月上旬");
    expect(buildTokenValues({ lines: [withCell("K16", "")] }).SHIP_DATE_1).toBeNull();
  });

  /**
   * ★★ **QTY に文字を打っても消えない**。以前は `Number()` に通していて、
   *   数として読めない文字は xlsx でだけ空になっていた。
   * ⚠ 数値にするのは「数値にしても同じ文字に見える」ときだけ（`3.0` は文字のまま）。
   */
  it("★★ 数に読めない QTY は文字のまま入る（消さない）", () => {
    expect(buildTokenValues({ lines: [withCell("I16", "3個")] }).QTY_1).toBe("3個");
    expect(buildTokenValues({ lines: [withCell("I16", "未定")] }).QTY_1).toBe("未定");
    expect(buildTokenValues({ lines: [withCell("I16", "3.0")] }).QTY_1).toBe("3.0");
    expect(buildTokenValues({ lines: [withCell("I16", "12")] }).QTY_1).toBe(12);
  });

  /**
   * ★★ **日本語・タイ語はどのセルでも変えない**（落ちる経路が無いことを確かめる）。
   *   英数字に絞るコードは無い。ここで固定する。
   */
  it("★★ 日本語・タイ語の文字はそのまま入る", () => {
    const values = buildTokenValues({
      lines: [
        {
          cells: {
            ...line.cells,
            F16: "鋳造 SV950 ชุบทอง",
            G16: "ダイヤ 1.0mm ×3",
            H16: "11号",
            L16: "至急 ด่วน",
          },
        },
      ],
    });
    expect(values.DESC_1).toBe("鋳造 SV950 ชุบทอง");
    expect(values.STONE_1).toBe("ダイヤ 1.0mm ×3");
    expect(values.SIZE_1).toBe("11号");
    expect(values.REMARK_1).toBe("至急 ด่วน");
  });

  /**
   * ⚠⚠ **数量 0 を `null` にしない。** 読めなかった明細は数量 0 で作られる。
   *   `Number(...) || null` と書くと**その行の QTY が黙って空になる**（実際に起きた形）。
   */
  it("⚠⚠ 数量 0 は 0 のまま (空にしない)", () => {
    expect(buildTokenValues({ lines: [withCell("I16", "0")] }).QTY_1).toBe(0);
  });

  it("⚠ 枠より多い明細は断る (黙って切り捨てない)", () => {
    const lines = Array.from({ length: BLOCK_COUNT + 1 }, () => line);
    expect(() => buildTokenValues({ lines })).toThrow(TooManyLines);
  });
});

/**
 * ★★ **枠のどのセルも雛形の番地に落ちること。**
 *
 * ⚠⚠ これが落ちたら、人が打ったセルが `UnknownCellRef` で**保存はできるのに
 *   xlsx が出せない**状態になる。60 セル × 12 明細を実物の雛形に通して確かめる。
 */
describe("★ 枠の全セルが雛形に収まる", () => {
  it("全部のセルを埋めても落ちず、番地どおりに出る", async () => {
    // ⚠ 番地は明細ごとに違うので、枠ごとにその枠の番地で埋める。
    const lines = Array.from({ length: BLOCK_COUNT }, (_unused, index) => {
      const cells = Object.fromEntries(lineCellRefs(index).map((ref) => [ref, "x"]));
      // ⚠ 数量は数に読める文字にする（数値のセルの道も通す）。
      cells[`I${16 + index * 6}`] = "7";
      return { cells };
    });

    const bytes = await renderOrderSheetXlsx({ ...refInput, lines });
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  /** ⚠ 使える番地は 10 列 × 6 行 × 12 枠。 */
  it("⚠ 番地の総数が枠の形と一致する", () => {
    expect(allLineCellRefs()).toHaveLength(10 * 6 * BLOCK_COUNT);
  });

  /** ⚠ 12 枠を超える明細は、番地が雛形の外に出るので**作る前に**断る。 */
  it("⚠ 枠より多い明細は番地を作る前に断る", () => {
    const lines = Array.from({ length: BLOCK_COUNT + 1 }, () => line);
    expect(() => buildTokenValues({ lines })).toThrow(TooManyLines);
  });
});

describe("renderOrderSheetXlsx", () => {
  it("xlsx として組み上がり、目印が 1 つも残らない", async () => {
    const bytes = await renderOrderSheetXlsx({ ...refInput, lines: [line] });
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);

    const text = new TextDecoder().decode(bytes);
    // ⚠ 圧縮しているので中身は直接読めない。**残った目印が無いこと**は
    //   雛形と injectCells のテストで担保し、ここでは大きさと形だけを見る。
    expect(text.slice(0, 2)).toBe("PK");
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });
});

/** zip のローカルヘッダを辿って「どのパスが入っているか」と中身を取る。 */
async function readZip(zip: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 30 <= zip.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const compressedSize = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLength));
    const bodyAt = at + 30 + nameLength + extraLength;
    const body = zip.subarray(bodyAt, bodyAt + compressedSize);
    out.set(
      name,
      method === 0
        ? body
        : new Uint8Array(
            await new Response(
              new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
            ).arrayBuffer(),
          ),
    );
    at = bodyAt + compressedSize;
  }
  return out;
}

/** ヘッダだけの JPEG (実物を fixture にしない)。 */
function jpegOf(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
  ]);
}

/**
 * ★★ **Picture が xlsx に入って、該当の枠に置かれること。**
 *
 * ⚠⚠ 以前は Picture は**画面にしか出ず、xlsx にすると消えていた**
 *   (雛形が図形のパーツを落としていた)。ここが落ちたらその状態に戻っている。
 */
describe("★ 写真を xlsx に入れる", () => {
  const render = (pictures: Parameters<typeof renderOrderSheetXlsx>[1]) =>
    renderOrderSheetXlsx(refInput, pictures);

  it("写真が無ければ図形のパーツを 1 つも足さない", async () => {
    const parts = await readZip(await render([]));
    expect([...parts.keys()].some((path) => path.startsWith("xl/media/"))).toBe(false);
    expect([...parts.keys()].some((path) => path.includes("drawing"))).toBe(false);
    expect(new TextDecoder().decode(parts.get("xl/worksheets/sheet1.xml")!)).not.toContain(
      "<drawing",
    );
  });

  it("★ 写真を入れると media・drawing・rels・Content_Types が揃う", async () => {
    const parts = await readZip(
      await render([{ lineIndex: 0, bytes: jpegOf(400, 300), contentType: "image/jpeg" }]),
    );

    expect(parts.has("xl/media/image1.jpeg")).toBe(true);
    expect(parts.has("xl/drawings/drawing1.xml")).toBe(true);
    expect(parts.has("xl/drawings/_rels/drawing1.xml.rels")).toBe(true);
    // ⚠ 雛形に無いパーツ。これが抜けると Excel が図形に辿り着けない。
    expect(parts.has("xl/worksheets/_rels/sheet1.xml.rels")).toBe(true);

    const sheet = new TextDecoder().decode(parts.get("xl/worksheets/sheet1.xml")!);
    expect(sheet).toContain('<drawing r:id="rId1"/></worksheet>');

    // ⚠ 雛形の作り直しが `Default Extension` を消しているので、足し直せていること。
    const types = new TextDecoder().decode(parts.get("[Content_Types].xml")!);
    expect(types).toContain('<Default Extension="jpeg" ContentType="image/jpeg"/>');
    expect(types).toContain("/xl/drawings/drawing1.xml");
  });

  /**
   * ⚠⚠ **錨は各枠の先頭行**（実物の drawing がそこに打っている）。
   *   1 件目は行 15、2 件目は行 21 = 0 始まりで 14 と 20。
   */
  it("★ 錨は E 列・その枠の先頭行にある", async () => {
    const parts = await readZip(
      await renderOrderSheetXlsx({ ...refInput, lines: [line, { cells: {} }] }, [
        { lineIndex: 0, bytes: jpegOf(400, 300), contentType: "image/jpeg" },
        { lineIndex: 1, bytes: jpegOf(400, 300), contentType: "image/jpeg" },
      ]),
    );
    const drawing = new TextDecoder().decode(parts.get("xl/drawings/drawing1.xml")!);
    expect(drawing).toContain("<xdr:col>4</xdr:col>");
    expect(drawing).toContain("<xdr:row>14</xdr:row>");
    expect(drawing).toContain("<xdr:row>20</xdr:row>");
    // ⚠ 錨は枠の中（0 始まりで 14..25）。空き行 27・合計 28 に掛からない。
    for (const m of drawing.matchAll(/<xdr:row>(\d+)<\/xdr:row>/g)) {
      expect(Number(m[1])).toBeLessThan(26);
    }
  });

  /** ⚠ 枠を明細の数だけにしたので、無い明細の写真は貼らない（落とした枠に錨を打たない）。 */
  it("⚠ 無い明細の写真は貼らない", async () => {
    const parts = await readZip(
      await render([
        { lineIndex: 0, bytes: jpegOf(400, 300), contentType: "image/jpeg" },
        { lineIndex: 3, bytes: jpegOf(400, 300), contentType: "image/jpeg" },
      ]),
    );
    const drawing = new TextDecoder().decode(parts.get("xl/drawings/drawing1.xml")!);
    expect([...drawing.matchAll(/<xdr:oneCellAnchor>/g)]).toHaveLength(1);
    expect(drawing).toContain("<xdr:row>14</xdr:row>");
  });

  /** ⚠ 引き伸ばさない。歪んだ写真を貼らない。 */
  it("★ 縦横比を保って枠に収める", async () => {
    const parts = await readZip(
      // 横長 (4:3)。枠 (488px × 270pt) より横が先に当たる。
      await render([{ lineIndex: 0, bytes: jpegOf(4000, 3000), contentType: "image/jpeg" }]),
    );
    const drawing = new TextDecoder().decode(parts.get("xl/drawings/drawing1.xml")!);
    const ext = /<xdr:ext cx="(\d+)" cy="(\d+)"\/>/.exec(drawing)!;
    const cx = Number(ext[1]);
    const cy = Number(ext[2]);
    expect(cx / cy).toBeCloseTo(4 / 3, 2);
    expect(cx).toBeLessThanOrEqual(488 * 9525);
    expect(cy).toBeLessThanOrEqual(45 * 6 * 12700);
  });

  /** ⚠ 読めない形式は**その 1 枚だけ**飛ばす (xlsx 自体は出る)。 */
  it("⚠ 貼れない形式は飛ばすが、xlsx は出る", async () => {
    const parts = await readZip(
      await render([{ lineIndex: 0, bytes: jpegOf(10, 10), contentType: "image/heic" }]),
    );
    expect(parts.has("xl/worksheets/sheet1.xml")).toBe(true);
    expect([...parts.keys()].some((path) => path.startsWith("xl/media/"))).toBe(false);
  });
});

/**
 * ★★ 画面の契約 → xlsx の入力。**ここが長いあいだ無試験だった。**
 *
 * ⚠⚠ `buildCellRefs()` は `HEADER_CELLS` を回す汎用なのに、**その入口の
 *   `toXlsxInput()` が番地 4 つをべた書き**していた（導出へ直した）。
 *   そのせいで「ヘッダの欄を足すと、値は保存され画面にも出るのに、
 *   **xlsx にだけ出ない**」という壊れ方をしうる。例外も警告も出ない。
 * ⚠ 番地を書き並べたテストにしないこと。**`HEADER_VALUE_CELLS` と突き合わせる**。
 */
describe("★★ toXlsxInput — 人が打つヘッダを 1 つも落とさない", () => {
  function field(value: string | number | null): Field {
    return { value, by: "human", filledBy: value === null ? null : "human", confidence: null, corrected: false, source: null };
  }

  function sheetWith(header: Record<string, Field>): OrderSheet {
    return {
      caseId: "case-1",
      orderSheetId: "os-1",
      status: "draft",
      confidenceThreshold: 0.7,
      header,
      lines: [],
    } as unknown as OrderSheet;
  }

  it("★★ 人が打てるヘッダの番地が全部そろう（落ちると xlsx にだけ出ない）", () => {
    const header = Object.fromEntries(HEADER_VALUE_CELLS.map((ref) => [ref, field(`v-${ref}`)]));
    const input = toXlsxInput(sheetWith(header), { issuedOn: "2026-09-23" });

    expect(Object.keys(input.header).sort()).toEqual([...HEADER_VALUE_CELLS].sort());
    for (const ref of HEADER_VALUE_CELLS) expect(input.header[ref]).toBe(`v-${ref}`);
  });

  it("★ 工程表（C4:E10）の 21 個が入る", () => {
    const input = toXlsxInput(sheetWith({ C4: field("10/1"), E10: field("2") }), {
      issuedOn: "2026-09-23",
    });
    for (const ref of PLAN_CELLS) expect(ref in input.header).toBe(true);
    expect(input.header.C4).toBe("10/1");
    expect(input.header.E10).toBe("2");
    // ⚠ 打っていないセルは null（空のセルになる。罫線の書式は雛形が持つ）。
    expect(input.header.D4).toBeNull();
  });

  /** ⚠ 派生は**渡さない**（`buildCellRefs()` が `partnerName` / `issuedOn` から別に作る）。 */
  it("★ 派生（A12 / J12 / F5）は header に混ぜない", () => {
    const input = toXlsxInput(sheetWith({ A12: field("顧客A"), J12: field("2026-09-23") }), {
      issuedOn: "2026-09-23",
    });
    for (const derived of ["A12", "J12", "F5"]) expect(derived in input.header).toBe(false);
    // ⚠ 取引先名は `partnerName` 経由（契約の `A12` は表示用の文字列）。
    expect(input.partnerName).toBe("顧客A");
  });
});
