import { describe, expect, it } from "vitest";
import type { Bindings } from "../../../shared/hono";
import { ORDER_SHEET_FIELDS, aiFieldTargets, targetColumnOf } from "../lib/order-sheet-fields";
import {
  OrderSheetNotGeneratable,
  generateOrderSheet,
  normalizeNoteText,
} from "./order-sheet-generator";

/**
 * ★★ **AI が書き込むのは 10 欄だけ**であることを固定する。
 *
 * ⚠⚠ ここが崩れると AI の欄と人の欄の塗り分けが成立しない。
 *   `Code / ID / PO・SO / SHIP(ヘッダ)` に 1 文字でも書いたら、
 *   画面は「AI が埋めた」と嘘をつく。「**埋まらない欄がある方が正しい**」。
 * ⚠ `@cloudflare/vitest-pool-workers` は使えない (vitest 5 と peer が合わない) ので、
 *   **SQL は実行せず**、どの表を引いたかで決まった行を返す偽の D1 を使う。
 *   確かめるのは「どの列に何を入れたか」と「欄の記録に何を積んだか」。
 * ⚠ 固有名詞を書かない。品番も発注番号もすべて架空のコード。
 */

// drizzle が `.raw()` で期待する**値の配列**を、各 select の並びどおりに作る。
const PO = ["po-1", "partner-1", "PO-0001", "2026-09-18"];
/**
 * 発注明細。
 * ⚠ 製造番号は **2 桁年**(実物の発注書がそう印字されている)。依頼書側は 4 桁年なので、
 *   これが結び付くかどうかが突き合わせの勘どころになる。
 */
const LINE = [
  "pol-1",
  1,
  "po-1",
  "99-12-S002",
  // 資材名 (Description の出どころ)。
  "SV950 キャスト材",
  "11",
  24,
  // ⚠ 出荷日 (requested_ship_date) は select から外した — **読み取りをやめた**ので、
  //   generator は明細の ship_date を触らない。ここに値を戻すと並びがずれる。
  // REMARK (オーダーNo の下の整理の記号)。
  "XX 0001",
];
/** findFieldRecord の 7 列。転記元に AI の記録がある状態。 */
const FIELD = ["aef-1", "quote", "value", 90, 0, 1, null];

/**
 * 依頼書 1 枚 (`revision_requests` + `revision_request_specs` の join)。
 * ⚠ **実物では仕様書No が 4 桁年、発注書の製造番号が 2 桁年**で印字される。
 */
const REVISION = [
  "rev-1",
  "2099-12-S002",
  "900000000001",
  // ⚠ 読み取りのときに ai が当てた対応づけ。**規則で結べるものはここに入らない** (既定は null)。
  null,
  "rrs-1",
  // 品位と、表題の下の区分。
  "SV950",
  "鋳造",
  // 下部のメモ。Size / STONE / Description#2 / #3 / #4。既定はメモ無し。
  null,
  null,
  null,
  null,
  null,
];
/** 区分の列の位置 (下部のメモの 5 列より前)。 */
const CATEGORY_AT = 6;
/** 下部のメモの 5 列が始まる位置。 */
const NOTE_AT = 7;
interface Options {
  /** 既にある ORDER SHEET (2 回目の生成)。 */
  existingSheet?: unknown[][];
  /** 発注書が 1 通も読めていない案件。 */
  noPurchaseOrder?: boolean;
  /** Customer PO が読めなかった発注書（右上が潰れていた、など）。 */
  noCustomerPoNo?: boolean;
  /** 転記元に AI の記録が無い (人が手で入れた発注書など)。 */
  noFieldRecords?: boolean;
  /** 依頼書が付いた案件 (内包 PDF)。 */
  withRevision?: boolean;
  /** 代表の図を切り出せた依頼書。 */
  withPhoto?: boolean;
  /** 区分が対応表 (description-text.ts) に無い依頼書。 */
  unknownCategory?: boolean;
  /** 仕様書No が升目の印字で、区切りに空白が挟まって読まれた依頼書。 */
  spacedSpecNo?: boolean;
  /** ⚠ 仕様書No も資材名も発注書と噛み合わない依頼書 (規則では結べない)。 */
  unmatchableRevision?: boolean;
  /** 読み取りのときに ai が当てた対応づけ (`revision_requests.purchase_order_line_id`)。 */
  aiLinkedLineId?: string;
  /**
   * 依頼書の下部のメモ。並びは Size / STONE / Description#2 / #3 / #4。
   * ⚠ 架空の値でよい (generator は値の中身を解釈しない)。
   */
  specNote?: (string | null)[];
  /** 発注書のサイズ (既定は "11")。null = 発注書にサイズが印字されていない明細。 */
  lineSize?: string | null;
  /** 発注書の REMARK (既定は "XX 0001")。null = AI が読めなかった明細。 */
  lineRemark?: string | null;
  /** 既にある明細 (2 回目の生成)。並びは id / cells_json / photo_file_id。 */
  existingLine?: unknown[][];
  /**
   * その明細に既に付いている代表の図の行 (`order_sheet_line_photos`)。
   * ⚠ **消した行も含める。** 並びは file_id / sort_key / deleted_at / files.sha256。
   */
  linePhotos?: unknown[][];
}

function fakeD1(options: Options = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];

  function rowsFor(sql: string): unknown[][] {
    if (/from "purchase_orders"/i.test(sql)) {
      if (options.noPurchaseOrder) return [];
      // ⚠ 並びは generator の select の順。3 つ目が customer_po_no。
      return [options.noCustomerPoNo ? [PO[0], PO[1], "", PO[3]] : PO];
    }
    if (/from "purchase_order_lines"/i.test(sql)) {
      // ⚠ サイズ (6 つ目) と REMARK (8 つ目) だけを差し替える。
      const line =
        options.lineSize === undefined
          ? LINE
          : [...LINE.slice(0, 5), options.lineSize, ...LINE.slice(6)];
      return [options.lineRemark === undefined ? line : [...line.slice(0, 7), options.lineRemark]];
    }
    if (/from "revision_requests"/i.test(sql)) {
      if (!options.withRevision) return [];
      // ⚠ 区分の列だけを差し替える。
      let revision: unknown[] = options.unknownCategory
        ? [...REVISION.slice(0, CATEGORY_AT), "見たことのない区分", ...REVISION.slice(CATEGORY_AT + 1)]
        : REVISION;
      // ★ 下部のメモの 5 列。
      if (options.specNote) revision = [...revision.slice(0, NOTE_AT), ...options.specNote];
      // ⚠ 仕様書No (2 つ目) だけを差し替える。
      let row = options.spacedSpecNo
        ? [revision[0], "2099 - 12 - S002", ...revision.slice(2)]
        : revision;
      // ⚠ 規則で結べない依頼書 (仕様書No も資材名も噛み合わない)。
      if (options.unmatchableRevision)
        row = [row[0], "9999-99-X999", "まったく別の品名", ...row.slice(3)];
      // ★ ai が当てた対応づけ (4 つ目)。
      if (options.aiLinkedLineId !== undefined) {
        row = [...row.slice(0, 3), options.aiLinkedLineId, ...row.slice(4)];
      }
      return [row];
    }
    if (/from "ai_extraction_fields"/i.test(sql)) return options.noFieldRecords ? [] : [FIELD];
    // ★ 明細に既に付いている絵 (消した行も含む)。⚠ files を leftJoin するので先に見る。
    if (/from "order_sheet_line_photos"/i.test(sql)) return options.linePhotos ?? [];
    if (/from "order_sheet_lines"/i.test(sql)) return options.existingLine ?? [];
    // ★ 代表の図。切り出せた依頼書があるときだけ 1 行返る。
    //   ⚠ 並びは id / storage_key / sha256 (墓標は sha256 でも見るので 3 列)。
    if (/from "files"/i.test(sql)) {
      return options.withPhoto ? [["file-1", "photos/spec/rev-1.jpg", "sha-1"]] : [];
    }
    if (/from "order_sheets"/i.test(sql)) return options.existingSheet ?? [];
    return [];
  }

  const client = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          const rows = rowsFor(sql);
          return {
            raw: async () => rows,
            all: async () => ({ results: rows, success: true, meta: {} }),
            run: async () => ({ results: [], success: true, meta: {} }),
          };
        },
      };
    },
  };
  return { client, calls };
}

const envOf = (client: unknown) => ({ DB: client }) as unknown as Bindings;

/**
 * `insert into "t" ("a", "b") values (?, null)` を 列 -> 実際の値 に開く。
 *
 * ⚠ **drizzle は値が無い列を `?` ではなく `null` リテラルで埋める。** 列の番号を
 *   そのまま params の番号にすると**ずれる**ので、values 側の並びを見て数える。
 */
function insertedColumns(
  calls: { sql: string; params: unknown[] }[],
  table: string,
): Record<string, unknown> | undefined {
  const call = calls.find((c) => new RegExp(`insert into "${table}"`, "i").test(c.sql));
  if (!call) return undefined;
  const parsed = new RegExp(`insert into "${table}" \\(([^)]*)\\) values \\(([^)]*)\\)`, "i").exec(
    call.sql,
  );
  if (!parsed) return undefined;

  const columns = parsed[1]!.split(",").map((name) => name.trim().replaceAll('"', ""));
  const slots = parsed[2]!.split(",").map((slot) => slot.trim());

  let next = 0;
  return Object.fromEntries(
    columns.map((name, index) => {
      const slot = slots[index];
      if (slot === "?") return [name, call.params[next++]];
      return [name, slot === "null" ? null : slot];
    }),
  );
}

/**
 * `update "t" set "a" = ?, "b" = null where ...` を 列 -> 実際の値 に開く。
 * ⚠ `insertedColumns` と同じ理由で、`?` の数だけ params を進める。
 */
/**
 * 書き込んだ `cells_json` を**セルの地図**に開く。
 *
 * ⚠ 明細の値は 1 列 (`cells_json`) にまとまったので、
 *   `insertedColumns(...).size_text` のような読み方はもう通らない。
 */
function cellsOf(columns: Record<string, unknown> | undefined): Record<string, string> {
  const raw = columns?.cells_json;
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, string>) : {};
}

function updatedColumns(
  calls: { sql: string; params: unknown[] }[],
  table: string,
): Record<string, unknown> | undefined {
  const call = calls.find((c) => new RegExp(`^\\s*update "${table}" set`, "i").test(c.sql));
  if (!call) return undefined;
  const parsed = new RegExp(`update "${table}" set (.*?) where `, "i").exec(call.sql);
  if (!parsed) return undefined;

  let next = 0;
  return Object.fromEntries(
    parsed[1]!.split(/,\s*(?=")/).map((part) => {
      const [name, slot] = part.split(" = ") as [string, string];
      const column = name.trim().replaceAll('"', "");
      if (slot.trim() === "?") return [column, call.params[next++]];
      return [column, slot.trim() === "null" ? null : slot.trim()];
    }),
  );
}

const run = (options?: Options) => {
  const { client, calls } = fakeD1(options);
  return generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" }).then(
    (result) => ({ result, calls }),
  );
};

describe("generateOrderSheet — 10 欄だけを書く", () => {
  it("欄の記録が AI の欄とちょうど一致する (写真を除く)", async () => {
    const { result } = await run({ withRevision: true, withPhoto: true });

    const written = new Set(result.fields.map((f) => `${f.targetTable}.${f.targetColumn}`));
    /*
     * ⚠⚠ **住所は明細ごとに解決される**。この fixture は明細 1 件なので
     *   `lineIndex = 0`（＝ 紙の 16 行目）。**`column` をそのまま使わないこと** —
     *   列の記号 (`"D"`) のままになって、来歴と突き合わない。
     */
    const expected = new Set(aiFieldTargets().map((t) => `${t.table}.${targetColumnOf(t.key, 0)}`));
    // ⚠ 増えても減っても駄目。ORDER_SHEET_FIELDS が唯一の正。
    expect([...written].sort()).toEqual([...expected].sort());
  });

  it("人が埋める欄には 1 つも書かない", async () => {
    const { result, calls } = await run();

    const humanColumns = ["item_code_text", "raw_text", "po_no", "so_no"];
    for (const column of humanColumns) {
      expect(result.fields.some((f) => f.targetColumn === column)).toBe(false);
    }

    const sheet = insertedColumns(calls, "order_sheets")!;
    // ⚠ PO / SO は社内システムが発行する欄。SHIP(ヘッダ) は営業が決める欄。
    expect(sheet.po_no).toBeNull();
    expect(sheet.so_no).toBeNull();
    expect(sheet.ship_date).toBeNull();

    const line = insertedColumns(calls, "order_sheet_lines")!;
    // ⚠ Code(社内品番) はプランニングが採番する。
    expect(line.item_code_text).toBeNull();

    // ID 欄 (社内システムの採番) には行ごと作らない。
    expect(calls.some((c) => /insert into "order_sheet_line_ids"/i.test(c.sql))).toBe(false);
  });

  it("★ REMARK は発注書のオーダーNo の下から写す", async () => {
    const { result, calls } = await run();
    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["L16"]).toBe("XX 0001");
    expect(
      result.fields.some(
        // ⚠ 来歴の「列」は**セルの鍵**（`"L16"` = 紙の L 列の値の行）。
        (f) => f.targetTable === "order_sheet_lines" && f.targetColumn === "L16",
      ),
    ).toBe(true);
  });

  it("⚠ 単位は固定値 (読み取りではない)", async () => {
    const { calls } = await run();
    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["J16"]).toBe("PCS");
  });

  it("★ 切り出せた代表の図を写真の欄に付ける", async () => {
    const { calls } = await run({ withRevision: true, withPhoto: true });
    expect(insertedColumns(calls, "order_sheet_lines")!.photo_file_id).toBe("file-1");
  });

  it("⚠ 切り出せていなければ写真の欄は空 (でっち上げない)", async () => {
    const { calls } = await run({ withRevision: true });
    expect(insertedColumns(calls, "order_sheet_lines")!.photo_file_id).toBeNull();
  });

  it("★ 切り出せた絵は order_sheet_line_photos にも 1 行入る (1 明細に複数枚)", async () => {
    const { calls } = await run({ withRevision: true, withPhoto: true });

    const photo = insertedColumns(calls, "order_sheet_line_photos")!;
    expect(photo.file_id).toBe("file-1");
    expect(photo.revision_request_id).toBe("rev-1");
    expect(photo.sort_key).toBe(0);
    // ⚠ 人が外していない絵なので deleted_at は空。
    expect(photo.deleted_at).toBeNull();
  });

  /**
   * ⚠⚠ **ここが今回の山。** 人が外した絵を読み直しで差し戻さないこと。
   *   外したことを持っているのは `order_sheet_line_photos.deleted_at` だけ。
   */
  it("⚠⚠ 人が外した絵は読み直しで戻さない (file_id が一致)", async () => {
    const { calls } = await run({
      withRevision: true,
      withPhoto: true,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, null]],
      // 同じ file_id が外されている。
      linePhotos: [["file-1", 0, 1, "sha-1"]],
    });

    expect(calls.some((c) => /insert into "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    // 生きている絵が 1 枚も無いので代表は空 (外した絵を欄に残さない)。
    expect(updatedColumns(calls, "order_sheet_lines")!.photo_file_id).toBeNull();
  });

  it("⚠⚠ 読み取りをやり直して file_id が変わっても、同じ絵なら戻さない (sha256 が一致)", async () => {
    const { calls } = await run({
      withRevision: true,
      withPhoto: true,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, null]],
      // ⚠ `revision_requests` ごと作り直されて file_id は変わっているが、中身は同じ。
      linePhotos: [["file-old", 0, 1, "sha-1"]],
    });

    expect(calls.some((c) => /insert into "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    expect(updatedColumns(calls, "order_sheet_lines")!.photo_file_id).toBeNull();
  });

  it("⚠ 生きている行は消さないし、入れ直しもしない (sort_key を保つ)", async () => {
    const { calls } = await run({
      withRevision: true,
      withPhoto: true,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, "file-1"]],
      linePhotos: [["file-1", 0, null, "sha-1"]],
    });

    expect(calls.some((c) => /insert into "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /delete from "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    // 生きている先頭がそのまま代表。
    expect(updatedColumns(calls, "order_sheet_lines")!.photo_file_id).toBe("file-1");
  });

  /**
   * ⚠⚠ **読み直しで枚数が増えないこと。** 「読み取りをやり直す」と `revision_requests` ごと
   *   作り直されて `file_id` が変わるので、`file_id` だけで見ていると**同じ絵が 2 行目**に
   *   なる (明細の行は `(order_sheet_id, line_no)` で引き直されるので残る)。
   *   墓標と対で、生きている行の `sha256` も見ている。
   */
  it("⚠⚠ 読み直しで file_id が変わっても、生きている絵と同じなら行を増やさない", async () => {
    const { calls } = await run({
      withRevision: true,
      withPhoto: true,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, "file-old"]],
      // 生きている行 (deleted_at は null)。file_id は違うが中身 (sha256) は同じ。
      linePhotos: [["file-old", 0, null, "sha-1"]],
    });

    expect(calls.some((c) => /insert into "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    // 代表も入れ替わらない (人から見れば同じ 1 枚のまま)。
    expect(updatedColumns(calls, "order_sheet_lines")!.photo_file_id).toBe("file-old");
  });

  /**
   * ★ 人が画面から上げた絵 (`photos/manual/`、`revision_request_id` は null) は、
   *   読み直しでも消えないし、代表の座も譲らない。
   * ⚠ generator は生きている行を消さない (＝「null で上書きしない」の複数枚版)。
   */
  it("★ 人が上げた絵は読み直しで消えない (依頼書の絵は末尾に足される)", async () => {
    const { calls } = await run({
      withRevision: true,
      withPhoto: true,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, "file-manual"]],
      linePhotos: [["file-manual", 0, null, "sha-manual"]],
    });

    expect(calls.some((c) => /delete from "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /update "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    // 切り出せた依頼書の絵は 2 枚目として足される。
    const photo = insertedColumns(calls, "order_sheet_line_photos")!;
    expect(photo.file_id).toBe("file-1");
    expect(photo.sort_key).toBe(1);
    expect(updatedColumns(calls, "order_sheet_lines")!.photo_file_id).toBe("file-manual");
  });

  it("★ 人が上げた絵は、今回切り出せなかった読み直しでも残る", async () => {
    const { calls } = await run({
      withRevision: true,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, "file-manual"]],
      linePhotos: [["file-manual", 0, null, "sha-manual"]],
    });

    expect(calls.some((c) => /insert into "order_sheet_line_photos"/i.test(c.sql))).toBe(false);
    expect(updatedColumns(calls, "order_sheet_lines")!.photo_file_id).toBe("file-manual");
  });

  it("⚠ 写真の行が 1 つも無い明細では、前に入っていた代表を null で上書きしない", async () => {
    const { calls } = await run({
      withRevision: true,
      // 今回は切り出せなかった (枠は毎回取れるとは限らない)。
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, "file-前回"]],
      linePhotos: [],
    });

    expect(updatedColumns(calls, "order_sheet_lines")!.photo_file_id).toBe("file-前回");
  });

  /**
   * ⚠⚠ **出荷日は 2 つとも人の欄になった。**
   *   明細の Ship date は出どころが確定できないので読み取りをやめた (印字の納期・
   *   手書きの出荷日・工程表の最終日が食い違う)。ヘッダの SHIP は元から営業が決める欄。
   *   **generator はどちらの列にも書かない。** 書くと、人が入れた出荷日が読み直しで消える。
   */
  it("⚠⚠ Ship date(明細) も SHIP(ヘッダ) も書かない (どちらも人の欄)", async () => {
    const { result, calls } = await run();

    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["K16"]).toBeUndefined();
    expect(insertedColumns(calls, "order_sheets")!.ship_date).toBeNull();
    // ⚠ 記録 (ai_extraction_fields) にも残さない。正答率の分母に入れないため。
    expect(
      result.fields.find(
        (f) => f.targetTable === "order_sheet_lines" && f.targetColumn === "ship_date",
      ),
    ).toBeUndefined();
  });

  it("⚠ 工程表は作らない (人が打つセル C4:E10。generator は書かない)", async () => {
    const { calls } = await run();
    expect(calls.some((c) => /insert into "production_plan/i.test(c.sql))).toBe(false);
  });

  it("確信度は転記元から引き継ぐ (転記で新しい確信度は生まれない)", async () => {
    const { result } = await run();
    expect(result.fields.every((f) => f.confidence === 90)).toBe(true);
    expect(result.fields.every((f) => f.pageNo === 1)).toBe(true);
  });

  it("転記元に AI の記録が無ければ、欄の記録を積まない (正答率の分母を水増ししない)", async () => {
    const { result } = await run({ noFieldRecords: true });
    expect(result.fields).toHaveLength(0);
    // 行そのものは作る (下書きは作れないと 1 行も書けずに止まる)。
    expect(result.lineCount).toBe(1);
  });
});

describe("generateOrderSheet — 冪等と、人の入力を壊さないこと", () => {
  it("2 回目は insert せず update する (case_id は UNIQUE)", async () => {
    const { calls } = await run({ existingSheet: [["os-1", "in_review"]] });

    expect(calls.some((c) => /insert into "order_sheets"/i.test(c.sql))).toBe(false);
    const update = calls.find((c) => /^\s*update "order_sheets"/i.test(c.sql))!;
    expect(update).toBeTruthy();
    // ⚠ 人が入れた欄を set 句に含めない。含めると上書きしてしまう。
    expect(update.sql).not.toMatch(/"po_no"/);
    expect(update.sql).not.toMatch(/"so_no"/);
    expect(update.sql).not.toMatch(/"ship_date"/);
  });

  it("人が見はじめた後 (in_review) は状態を巻き戻さない", async () => {
    const { calls } = await run({ existingSheet: [["os-1", "in_review"]] });
    const update = calls.find((c) => /^\s*update "order_sheets"/i.test(c.sql))!;
    expect(update.sql).not.toMatch(/"status"/);
  });

  it("draft のうちは ai_generated に進める", async () => {
    const { calls } = await run({ existingSheet: [["os-1", "draft"]] });
    const update = calls.find((c) => /^\s*update "order_sheets"/i.test(c.sql))!;
    expect(update.sql).toMatch(/"status"/);
  });

  it("読み取りをやり直して明細が減ったら、古い行を残さない", async () => {
    const { calls } = await run();
    expect(
      calls.some(
        (c) => /delete from "order_sheet_lines"/i.test(c.sql) && /"line_no" > \?/.test(c.sql),
      ),
    ).toBe(true);
  });
});

describe("generateOrderSheet — まだ組めないとき", () => {
  it("発注書が 1 通も読めていなければ OrderSheetNotGeneratable", async () => {
    // ⚠ 依頼書だけ先に読み終わった瞬間に起きる。**失敗ではない。**
    await expect(run({ noPurchaseOrder: true })).rejects.toBeInstanceOf(OrderSheetNotGeneratable);
  });
});

describe("★ 依頼書が付いた案件 — 実物の ORDER SHEET に合わせる", () => {
  it("Code master は依頼書の仕様書No (4 桁年)。⚠ 2 段目 (原型番号) は入れない", async () => {
    // ⚠ 発注書の製造番号は 2 桁年に略されていることがある。ORDER SHEET には 4 桁で載るので、
    //   結び付いた依頼書の番号を使う (実物で確認した)。
    const { client, calls } = fakeD1({ withRevision: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    const cells = cellsOf(insertedColumns(calls, "order_sheet_lines"));
    expect(cells["D16"]).toBe("2099-12-S002");
    // ⚠⚠ **原型No のセル (`"D17"`) は書かない。** 人が打った値を読み直しで消さないため。
    expect(cells["D17"]).toBeUndefined();
  });

  /**
   * ⚠ 依頼書の仕様書No は**升目に区切られて印字**されているので、読み取りが
   *   `2099 - 12 - S002` のように空白を挟んで返すことがある。ORDER SHEET には詰めて載せる。
   * ⚠⚠ **整えるのは ORDER SHEET の列だけ。** 読み取りの記録と突き合わせの鍵は印字そのまま。
   */
  it("★ 升目の印字で空白が挟まっても、Code master は詰めて載せる", async () => {
    const { client, calls } = fakeD1({ withRevision: true, spacedSpecNo: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["D16"]).toBe("2099-12-S002");
  });

  /**
   * ★ 実物の ORDER SHEET は指輪の号数に `#` が付く (発注書の印字は数字だけ)。
   * ⚠ 長さの表記には付けない (`lib/size-text.ts`)。
   */
  it("★ Size は数字だけの印字なら号数の印を付ける", async () => {
    const { client, calls } = fakeD1({ withRevision: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["H16"]).toBe("#11");
  });

  it("★ Description は「区分の語 + 品位」(依頼書が鋳造なら CASTING SV950)", async () => {
    const { client, calls } = fakeD1({ withRevision: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["F16"]).toBe("CASTING SV950");
  });

  /**
   * ★★ **ai が当てた対応づけ (`revision_requests.purchase_order_line_id`) の効き方。**
   *
   * ⚠ `links` が持つのは PDF の中の添字だけなので、読み取りのときに D1 の ID へ開いて
   *   保存してある。ORDER SHEET は別ジョブなので、保存していないと届かない。
   * ⚠⚠ **正は `matchBySpecNo` のまま。** ここは規則が結べなかった明細の**埋め草**。
   */
  it("⚠ 規則で結べず、保存された対応づけも無ければ結ばない (でっち上げない)", async () => {
    const { client, calls } = fakeD1({ withRevision: true, unmatchableRevision: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    const line = insertedColumns(calls, "order_sheet_lines")!;
    expect(line.description_text).toBeNull();
    expect(line.revision_request_id).toBeNull();
  });

  it("★ 規則で結べなくても、保存された対応づけがあれば結ぶ", async () => {
    const { client, calls } = fakeD1({
      withRevision: true,
      unmatchableRevision: true,
      aiLinkedLineId: "pol-1",
    });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    const line = insertedColumns(calls, "order_sheet_lines")!;
    expect(line.revision_request_id).toBe("rev-1");
    // 結ばれたので、依頼書の区分と品位から Description が出る。
    expect(cellsOf(line)["F16"]).toBe("CASTING SV950");
  });

  /** ⚠ 読み直しで明細が減ることがある。**いまある明細にしか当てない。** */
  it("⚠ 保存された対応づけが消えた明細を指していたら結ばない", async () => {
    const { client, calls } = fakeD1({
      withRevision: true,
      unmatchableRevision: true,
      aiLinkedLineId: "pol-消えた",
    });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    expect(insertedColumns(calls, "order_sheet_lines")!.revision_request_id).toBeNull();
  });

  /**
   * ⚠⚠ **発注書の資材名へは落とさない。** 資材名は細かい印字で読み違えが起きる
   *   (実測で、紙に無い `SV950 部品X` が Description に入った)。
   *   **空のほうが正しい**。
   */
  it("⚠⚠ 依頼書が付かなければ Description は空 (資材名で埋めない)", async () => {
    const { calls } = await run();
    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["F16"]).toBeUndefined();
  });

  it("⚠ 区分が一覧に無ければ Description は空 (勝手に語を作らない)", async () => {
    const { client, calls } = fakeD1({ withRevision: true, unknownCategory: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });
    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["F16"]).toBeUndefined();
  });

  it("⚠ POLISH・メッキ・ロゴは Description に入れない (人の欄)", async () => {
    const { client, calls } = fakeD1({ withRevision: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    const text = String(cellsOf(insertedColumns(calls, "order_sheet_lines"))["F16"]);
    expect(text).not.toContain("POLISH");
    expect(text).not.toContain("メッキ");
    expect(text).not.toContain("Logo");
  });

  /**
   * ⚠⚠ **STONE には一切触らない。**
   *
   *   AI の読み取りから石を外したので、この欄の出どころは**人の入力だけ**
   *   (紙の G 列のセル = `cells_json` の "G16") になった。
   *   以前は明細ごとに `order_sheet_line_stones` を**無条件に delete** してから
   *   入れ直していたので、**読み取りをやり直すたびに人が入れた STONE が消える**。
   *   delete も insert も出ないことを固定する。
   */
  /**
   * ⚠⚠ **単位は新しい明細を作るときだけ入れる。**
   *   `unit_code` は NOT NULL なので既定値が要るが、**読み取りの値ではない**
   *   (人が画面で直せる欄になった)。更新の `set` に混ぜると、
   *   **読み直しのたびに人が直した Unit が `PCS` に戻る**。
   */
  it("⚠⚠ 2 回目の生成では unit_code を書かない (人が直した Unit を消さない)", async () => {
    const { calls } = await run({
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", null, null]],
    });

    // ⚠ 読み直しでは単位のセルを書かない (人が直した値を消さないため)。
    expect(cellsOf(updatedColumns(calls, "order_sheet_lines"))["J16"]).toBeUndefined();
  });

  it("新しい明細には既定の単位を入れる (unit_code は NOT NULL)", async () => {
    const { calls } = await run();
    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["J16"]).toBe("PCS");
  });

  it("⚠⚠ 石の表には触らない (人が入れた STONE を読み直しで消さない)", async () => {
    const { client, calls } = fakeD1({ withRevision: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    expect(calls.filter((c) => /order_sheet_line_stones/i.test(c.sql))).toEqual([]);
  });

  it("⚠ 依頼書が付いても人の欄には書かない", async () => {
    const { client, calls } = fakeD1({ withRevision: true });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    const line = insertedColumns(calls, "order_sheet_lines") ?? {};
    // 人の欄に 1 文字でも書いたら、画面が「AI が埋めた」と嘘をつく。
    expect(line.item_code_text).toBeNull();
    expect(calls.some((c) => /insert into "order_sheet_line_ids"/i.test(c.sql))).toBe(false);
  });
});

/**
 * ⚠⚠ Description は **AI が 1 行目、人が 2 行目以降**を書く 1 つの列。
 *   読み直しで丸ごと上書きすると、人が書き足した POLISH・メッキ・ロゴが黙って消える。
 */
/**
 * ★★ **読み直しが人の打ったセルを消さないこと。**
 *
 * ⚠⚠ 以前は `replaceFirstRow()` という仕掛けで「Description の 1 行目だけ
 *   差し替える」ことをしていた（1 つの列に複数セルぶんが改行で入っていたため）。
 *   セルが分かれたいまは、**AI の鍵だけ差し替えて残りを持ち越す**だけでよい。
 *   ⚠ ここが落ちたら、人が打った原型No・POLISH・メッキ・ロゴが読み直しで消える。
 */
describe("★ 読み直しは人のセルを消さない", () => {
  it("AI のセルだけを差し替え、人のセルはそのまま残す", async () => {
    const human = {
      D17: "G990321",
      F17: "POLISH",
      F20: "Logo 0°C SILVER",
      B16: "9ZZZ209905S001ABC",
      K16: "2099-02-01",
    };
    const { client, calls } = fakeD1({
      withRevision: true,
      // ⚠ 並びは generator の select の順 (偽の D1 は位置で返す): id / cellsJson / photoFileId。
      existingLine: [["osl-1", JSON.stringify(human), null]],
    });
    await generateOrderSheet(envOf(client), { caseId: "case-1", aiJobId: "job-1" });

    const cells = cellsOf(updatedColumns(calls, "order_sheet_lines"));
    // 人が打ったセルは 1 つも消えていない。
    for (const [key, value] of Object.entries(human)) {
      expect(cells[key]).toBe(value);
    }
    // AI のセルは入っている。
    expect(cells["D16"]).toBe("2099-12-S002");
    expect(cells["F16"]).toBe("CASTING SV950");
  });
});

/**
 * ★★ **REMARK は AI が読めなかった読み直しで消さない**。
 *
 * ⚠⚠ AI は REMARK を null で返すことが多い (見出しの無い欄)。以前は null のとき
 *   `L` の鍵を**消していた**ので、人が画面で入れた Remark が読み直しのたびに消えた。
 *   Picture (`photoFileId`) と同じく「null で上書きしない」に揃えた。
 * ⚠ 値が返ったときは上書きする (読み直しで直った値が入るように)。
 */
describe("★ REMARK は読み直しで人の入力を消さない", () => {
  const humanRemark = { L16: "人が入れた記号" };

  it("⚠⚠ AI が null を返したら、既にある L のセルを残す", async () => {
    const { calls } = await run({
      lineRemark: null,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", JSON.stringify(humanRemark), null]],
    });
    expect(cellsOf(updatedColumns(calls, "order_sheet_lines"))["L16"]).toBe("人が入れた記号");
  });

  it("AI が値を返したら上書きする", async () => {
    const { calls } = await run({
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", JSON.stringify(humanRemark), null]],
    });
    expect(cellsOf(updatedColumns(calls, "order_sheet_lines"))["L16"]).toBe("XX 0001");
  });

  it("新しい明細で AI が null なら、L のセルは作らない (でっち上げない)", async () => {
    const { calls } = await run({ lineRemark: null });
    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["L16"]).toBeUndefined();
  });
});

/**
 * ★★ Customer PO（`J7`）が**画面に届く**こと。
 *
 * ⚠⚠ **実データで見つけた取り残し。** ヘッダの値を物理列から
 *   `order_sheets.cells_json`（鍵＝番地）へ移したとき、reader / PATCH writer / xlsx /
 *   migration は直したのに**この generator だけ直し忘れていた**。そのため
 *   `purchase_orders.customer_po_no` にも `ai_extraction_fields`（`J7` / 確信度 95）にも
 *   正しく入っているのに、**画面と xlsx には 1 度も出なかった**（例外も警告も出ない）。
 *   migration が既存行を 1 回だけ埋めていたので、**古い案件だけ表示される**という
 *   気づきにくい出方をしていた。
 * ⚠ ヘッダで AI が埋めるのは `J7` だけ（`J5` SHIP / `D12` PO / `F12` SO は人の欄）。
 *   だから症状が Customer PO 1 つに出た。
 */
describe("ヘッダのセル (order_sheets.cells_json)", () => {
  it("★★ Customer PO は cells_json の J7 に入る", async () => {
    const { calls } = await run();
    const cells = cellsOf(insertedColumns(calls, "order_sheets"));
    expect(cells[targetColumnOf("customerPoNo")]).toBe("PO-0001");
    expect(targetColumnOf("customerPoNo")).toBe("J7");
  });

  /**
   * ⚠⚠ **同じ地図に人のセルが同居している**（SHIP / PO / SO と工程表の 21 セル）。
   *   丸ごと置き換えると、**読み直しのたびに人が打った値が消える**（明細側と同じ罠）。
   */
  it("★★ 読み直しても人が打ったヘッダのセルは消えない", async () => {
    const human = {
      J5: "28/4/99",
      D12: "9012345",
      F12: "9012346",
      C4: "9/16",
      E10: "2",
    };
    const { calls } = await run({
      // ⚠ 並びは generator の select の順: id / status / cellsJson。
      existingSheet: [["os-1", "in_review", JSON.stringify(human)]],
    });

    const cells = cellsOf(updatedColumns(calls, "order_sheets"));
    for (const [ref, value] of Object.entries(human)) {
      expect(cells[ref], ref).toBe(value);
    }
    // AI のセルは差し替わっている。
    expect(cells.J7).toBe("PO-0001");
  });

  /** ⚠ 読めなかったセルは**鍵ごと消す**（`null` を溜めない）。明細側と同じ。 */
  it("★ 発注No が読めなければ J7 は鍵ごと消える", async () => {
    const { calls } = await run({
      noCustomerPoNo: true,
      existingSheet: [
        ["os-1", "in_review", JSON.stringify({ J7: "前回読めた値", D12: "9012345" })],
      ],
    });

    const cells = cellsOf(updatedColumns(calls, "order_sheets"));
    expect(cells.J7).toBeUndefined();
    // ⚠ 人のセルは道連れにしない。
    expect(cells.D12).toBe("9012345");
  });

  /**
   * ⚠⚠ **AI が埋めるヘッダの欄が増えたら、ここも増やさないと同じ穴が開く。**
   *   generator は `ORDER_SHEET_FIELDS` から一覧を導出して、値が渡されていなければ
   *   名指しで落とす。この検査は「導出の元」が変わったことに気づくためのもの。
   */
  it("★★ AI が埋めるヘッダのセルは J7 だけ", async () => {
    expect(
      aiFieldTargets()
        .filter((target) => target.table === "order_sheets")
        .map((target) => ORDER_SHEET_FIELDS[target.key].column)
        // ⚠ セルではない欄（CUSTOMER = `partner_id`）を落とす。generator の導出と同じ線。
        .filter((column) => /^[A-L]\d+$/u.test(column)),
    ).toEqual(["J7"]);
  });
});

/**
 * ★★ 依頼書の**下部のメモ** (**将来は消す**)。
 *
 * ⚠⚠ STONE / POLISH / メッキ / ロゴは**人の欄**。メモがあっても**空のセルにだけ**入れ、
 *   読み直しで人の入力を上書きしない。Size は**発注書が空の明細だけ**メモで埋める。
 * ⚠ 値は架空 (generator は中身を解釈しない)。
 */
describe("★ 下部のメモ — 空のセルにだけ入れる", () => {
  const NOTE = ["12", "石の指定", "仕上げの指定", "メッキの指定", "ロゴの指定"];

  it("★ メモがあれば STONE / POLISH / メッキ / ロゴのセルに入る (F19 は空のまま)", async () => {
    const { calls } = await run({ withRevision: true, specNote: NOTE });

    const cells = cellsOf(insertedColumns(calls, "order_sheet_lines"));
    expect(cells["G16"]).toBe("石の指定");
    expect(cells["F17"]).toBe("仕上げの指定");
    expect(cells["F18"]).toBe("メッキの指定");
    expect(cells["F19"]).toBeUndefined();
    expect(cells["F20"]).toBe("ロゴの指定");
    // ⚠ Description の値の行 (F16) はメモでは触らない。
    expect(cells["F16"]).toBe("CASTING SV950");
  });

  it("⚠⚠ 人が入れたセルは読み直しで上書きしない", async () => {
    const human = { G16: "人の石", F17: "人の仕上げ", F20: "人のロゴ" };
    const { calls } = await run({
      withRevision: true,
      specNote: NOTE,
      existingSheet: [["os-1", "ai_generated"]],
      existingLine: [["osl-1", JSON.stringify(human), null]],
    });

    const cells = cellsOf(updatedColumns(calls, "order_sheet_lines"));
    expect(cells["G16"]).toBe("人の石");
    expect(cells["F17"]).toBe("人の仕上げ");
    expect(cells["F20"]).toBe("人のロゴ");
    // ⚠ 空だったセルだけは埋まる。
    expect(cells["F18"]).toBe("メッキの指定");
  });

  it("⚠ 発注書にサイズがあれば、メモの Size は使わない", async () => {
    const { calls } = await run({ withRevision: true, specNote: NOTE });
    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["H16"]).toBe("#11");
  });

  it("★ 発注書のサイズが空の明細は、メモの Size で埋める (号数の印も付く)", async () => {
    const { result, calls } = await run({ withRevision: true, specNote: NOTE, lineSize: null });

    expect(cellsOf(insertedColumns(calls, "order_sheet_lines"))["H16"]).toBe("#12");
    // ⚠ 来歴は AI の欄 (Size) として 1 行だけ積む。
    expect(result.fields.filter((f) => f.targetColumn === "H16")).toHaveLength(1);
  });

  it("⚠ メモが無ければ人のセルは空のまま (でっち上げない)", async () => {
    const { calls } = await run({ withRevision: true, lineSize: null });

    const cells = cellsOf(insertedColumns(calls, "order_sheet_lines"));
    for (const ref of ["G16", "F17", "F18", "F20", "H16"]) {
      expect(cells[ref]).toBeUndefined();
    }
  });

  /** ⚠⚠ 人の欄なので、欄の記録を積むと正答率の分母が水増しされる。 */
  it("⚠⚠ メモで埋めても欄の記録は AI の欄とちょうど一致する", async () => {
    const { result } = await run({ withRevision: true, withPhoto: true, specNote: NOTE });

    const written = new Set(result.fields.map((f) => `${f.targetTable}.${f.targetColumn}`));
    const expected = new Set(aiFieldTargets().map((t) => `${t.table}.${targetColumnOf(t.key, 0)}`));
    expect([...written].sort()).toEqual([...expected].sort());
  });
});

/**
 * ⚠⚠ メモの値の正規化。帳票には**日本語・タイ語・英数字が 1 つの語の中で混ざる**。
 * ⚠ 値はすべて架空 (タイ文字は正規化で壊れやすい形の見本として選んだ語で、サンプルの値ではない)。
 */
describe("★ 下部のメモの値の正規化", () => {
  it("★ 温度の 1 文字の記号を紙の印字の形に寄せる", () => {
    expect(normalizeNoteText("Logo 0℃ SILVER")).toBe("Logo 0°C SILVER");
    expect(normalizeNoteText("100℉")).toBe("100°F");
    // 既に紙の形なら変えない。
    expect(normalizeNoteText("Logo 0°C SILVER")).toBe("Logo 0°C SILVER");
  });

  it("⚠⚠ タイ文字を壊さない (NFKC なら ำ が分解される)", () => {
    // ำ (U+0E33) は NFKC で ํ + า の 2 文字になる。ここでそうならないことを見る。
    const thai = "ทำ K18 +PT";
    expect(thai.normalize("NFKC")).not.toBe(thai);
    expect(normalizeNoteText(thai)).toBe(thai);
    // 日本語・タイ語・英数字が 1 つの語の中で混ざっても、そのまま残る。
    const mixed = "(日本語)ทำABC-12";
    expect(normalizeNoteText(`  ${mixed}  `)).toBe(mixed);
  });

  it("⚠ 半角カナや全角英数字は寄せない (紙がそうならそのまま)", () => {
    expect(normalizeNoteText("ﾒｯｷ ＡＢＣ")).toBe("ﾒｯｷ ＡＢＣ");
  });

  it("空・null は空文字", () => {
    expect(normalizeNoteText(null)).toBe("");
    expect(normalizeNoteText("   ")).toBe("");
  });

  it("★ セルに入るのは寄せたあとの値", async () => {
    const { calls } = await run({
      withRevision: true,
      specNote: ["12", "石の指定", "仕上げの指定", "ทำ メッキ", "Logo 0℃"],
    });

    const cells = cellsOf(insertedColumns(calls, "order_sheet_lines"));
    expect(cells["F18"]).toBe("ทำ メッキ");
    expect(cells["F20"]).toBe("Logo 0°C");
  });
});
