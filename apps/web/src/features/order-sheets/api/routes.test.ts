import { describe, expect, it } from "vitest";
import type { Bindings } from "../../../shared/hono";
import { headerFieldKeys, orderSheetSchema } from "../schema";
import { cellOf, isTextCell, sheetXml } from "../lib/xlsx-read";
import { routes } from "./routes";

/**
 * ★★ **API が「誰が埋めたか」の事実を返す**ことを固定する。
 *
 * ⚠⚠ 画面は `filledBy` / `confidence` / `corrected` だけを見て塗り分ける。
 *   ここが嘘をつくと、AI の欄と人の欄の塗り分けが崩れる。
 * ⚠ **欄は 1 つも省かない。** 画面は `if (!field) return null` で飛ばすので、省くと
 *   「人が埋める空の欄」が画面から消える。**空で返すことに意味がある**。
 * ⚠ SQL は実行しない偽の D1。確かめるのは組み立ての規則。
 * ⚠ 固有名詞を書かない。取引先は「顧客A」、品番は架空のコード。
 */

// ⚠ 並びは `order-sheet-reader.ts` の select そのまま
//   (id, status, partner_id, partners.name, partners.is_active, cells_json)。
// ⚠⚠ ヘッダの値は `cells_json`。物理の列はもう読まない。
// ⚠ `issued_on` は 引かない（`J12` は「いま xlsx を出したら入る日」）。
const HEADER_CELLS = { J7: "PO-0001" };
const SHEET = ["os-1", "ai_generated", "partner-1", "顧客A", 1, JSON.stringify(HEADER_CELLS)];
/**
 * ⚠ 並びは `order-sheet-reader.ts` の select の順 (偽の D1 は位置で返す):
 *   id / lineNo / photoFileId / cellsJson。
 * ⚠⚠ 明細の値は**すべて `cells_json`**。鍵は **xlsx の番地**（`"D16"` = 1 件目の D 列）。
 */
const CELLS = {
  "D16": "CIC-0001",
  "F16": "リング",
  "H16": "11",
  "I16": "24",
  "J16": "PCS",
  "K16": "2026-11-14",
};
const LINE = ["osl-1", 1, null, JSON.stringify(CELLS)];
const STONE = ["oss-1", "osl-1", "ラウンド 2.0mm x 6", 0];

interface Options {
  sheet?: unknown[][];
  lines?: unknown[][];
  /** ai_extraction_fields の行 (targetTable, targetRowId, targetColumn, normalized, confidence, page)。 */
  aiFields?: unknown[][];
  /** 走っている読み取りジョブ (あると明細の空の枠が出る)。 */
  jobs?: unknown[][];
  corrections?: unknown[][];
  /** 明細に付いている代表の図 (`order_sheet_line_photos`)。 */
  photos?: Photo[];
}

/** ⚠ 読む側と書く側で select の列が違うので、行ではなく**値**で持つ。 */
interface Photo {
  id: string;
  lineId: string;
  fileId: string;
  sortKey: number;
  /** 人が外した日時 (外していなければ null)。 */
  deletedAt: number | null;
}

const PHOTOS: Photo[] = [
  { id: "osp-1", lineId: "osl-1", fileId: "file-1", sortKey: 0, deletedAt: null },
  { id: "osp-2", lineId: "osl-1", fileId: "file-2", sortKey: 1, deletedAt: null },
];

function fakeD1(options: Options = {}) {
  function rowsFor(sql: string): unknown[][] {
    if (/from "order_sheets"/i.test(sql) && /left join "partners"/i.test(sql)) {
      return options.sheet ?? [SHEET];
    }
    // ⚠ 書き込み側は partners を join せず `id, status, cells_json` の 3 列を引く。
    if (/from "order_sheets"/i.test(sql)) {
      const sheet = options.sheet ?? [SHEET];
      return sheet.map((row) => [row[0], row[1], row[5]]);
    }
    if (/from "order_sheet_lines"/i.test(sql)) {
      const lines = options.lines ?? [LINE];
      // 写真を外すときは `id` だけを引く。
      if (/select "id" from "order_sheet_lines"/i.test(sql)) return lines.map((row) => [row[0]]);
      /*
       * 書き込み側は存在確認とセルの地図を 1 回で引く。
       * ⚠⚠ **`line_no` も引くようになった**。番地が行番号を含むので、
       *   送られたセルがその明細の枠のものかを writer が確かめるため。
       */
      if (/select "id", "line_no", "cells_json" from "order_sheet_lines"/i.test(sql)) {
        return lines.map((row) => [row[0], row[1], row[3]]);
      }
      return lines;
    }
    if (/from "order_sheet_line_stones"/i.test(sql)) return [STONE];
    if (/from "order_sheet_line_photos"/i.test(sql)) {
      const photos = options.photos ?? [];
      // ⚠ 一覧 (reader) は生きているものだけを引く。並びは id / 明細 / file_id / sort_key。
      if (/"order_sheet_line_id"/i.test(sql.split(" from ")[0] ?? "")) {
        return photos
          .filter((photo) => photo.deletedAt === null)
          .map((photo) => [photo.id, photo.lineId, photo.fileId, photo.sortKey]);
      }
      // ⚠ 足す側 (addLinePhoto) は末尾を決めるので sort_key も引く。
      //   並びは id / file_id / sort_key / deleted_at。
      if (/"sort_key"/i.test(sql.split(" from ")[0] ?? "")) {
        return photos.map((photo) => [photo.id, photo.fileId, photo.sortKey, photo.deletedAt]);
      }
      // ⚠ 書く側 (deleteLinePhoto) は**消した行も**引く。並びは id / file_id / deleted_at。
      return photos.map((photo) => [photo.id, photo.fileId, photo.deletedAt]);
    }
    if (/from "order_sheet_line_ids"/i.test(sql)) return [];
    // 取り込み中のジョブ (あると明細の空の枠が出る)。
    if (/from "ai_jobs"/i.test(sql)) return options.jobs ?? [];
    if (/from "ai_extraction_fields"/i.test(sql)) return options.aiFields ?? [];
    if (/from "ai_field_corrections"/i.test(sql)) return options.corrections ?? [];
    return [];
  }

  const client = {
    prepare(sql: string) {
      return {
        bind() {
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
  return client;
}

const get = async (options?: Options) => {
  const res = await routes.request("/case-1", {}, { DB: fakeD1(options) } as unknown as Bindings);
  expect(res.status).toBe(200);
  // ⚠ 契約そのもので検証する。形がずれたらここで落ちる。
  return orderSheetSchema.parse(await res.json());
};

describe("GET /:caseId", () => {
  it("ORDER SHEET がまだ無い案件にも同じ形の空の枠を 200 で返す", async () => {
    // シードで作った案件や、読み取りが終わる前に画面を開いたとき。
    const sheet = await get({ sheet: [] });

    expect(sheet.orderSheetId).toBe("");
    expect(sheet.status).toBe("draft");
    /*
     * 画面が「未入力」と描けるように、ヘッダの欄は**契約にあるものを全部**返す。
     * ⚠⚠ **鍵は番地**。`J12`(DATE) も欄になり、同時に
     *   工程表（`C4:E10`）が入って 6 → 27 になった。
     * ⚠ PO(`D12`) と SO(`F12`) は別の欄 (実物でも別のセル)。1 欄にまとめない。
     * ⚠⚠ **番地を書き並べず `headerFieldKeys` と突き合わせる。** 欄が増えるたびに
     *   ここを書き換えるのでは、「空の枠にだけ欄が無い」を捕まえられない。
     */
    expect(Object.keys(sheet.header).sort()).toEqual([...headerFieldKeys].sort());
    expect(Object.keys(sheet.header)).toHaveLength(27);
    // ⚠ 取り込み中でなければ明細は 0 行 (空の枠を出すのは読み取りが走っている間だけ)。
    expect(sheet.lines).toEqual([]);
  });

  it("★ 取り込み中は明細の空の枠を 1 行返す (0 行だと画面に表が出ない)", async () => {
    const sheet = await get({ sheet: [], jobs: [["job-1"]] });

    expect(sheet.lines).toHaveLength(1);
    // ⚠ `lineId` が空 = 保存に混ぜない印。
    expect(sheet.lines[0]?.lineId).toBe("");
    // 欄は全部返る。AI の欄かどうかは `by` で分かるので、画面はスピナーを回せる。
    // AI が埋めるセルは空でも返る。`by` で分かるので、画面はスピナーを回せる。
    expect(sheet.lines[0]?.cells["D16"]).toMatchObject({
      value: null,
      by: "ai",
      filledBy: null,
    });
  });

  it("AI の記録が無い欄は人の欄として返す (空なら誰も入れていない)", async () => {
    const sheet = await get();

    // ⚠ 人と社内システムが埋める欄。**空が正常。**
    expect(sheet.header.D12).toMatchObject({ value: null, filledBy: null });
    expect(sheet.header.F12).toMatchObject({ value: null, filledBy: null });
    expect(sheet.header.J5).toMatchObject({ value: null, filledBy: null });
    // ⚠ 人のセルは値が無ければ返らない。画面が空欄として並べる。
    expect(sheet.lines[0]?.cells["B16"]).toBeUndefined();
    expect(sheet.lines[0]?.cells["C16"]).toBeUndefined();
    // ⚠ Picture は AI の欄。切り出せていなければ空のまま。
    expect(sheet.lines[0]?.picture).toMatchObject({ value: null, by: "ai" });
  });

  /**
   * ⚠⚠ **原型No は Code master の 1 つ下のセル**（`"D17"` = `D17`）。
   *   以前は 1 つの欄に改行で詰めていた。**戻さないこと** — 1 段目だけが
   *   発注書と依頼書を結ぶ鍵なので、混ぜると鍵が汚れる。
   */
  it("★ 原型No は Code master の 1 つ下のセルで返る", async () => {
    const sheet = await get({
      lines: [["osl-1", 1, null, JSON.stringify({ ...CELLS, "D17": "G-0001" })]],
    });
    expect(sheet.lines[0]?.cells["D16"]?.value).toBe("CIC-0001");
    expect(sheet.lines[0]?.cells["D17"]?.value).toBe("G-0001");
  });

  /**
   * ⚠ 返すのは「値のあるセル」と「AI が埋めるセル」だけ。60 セルを毎回返さない。
   *   画面が枠の格子を作り、無い鍵は空欄にする。
   */
  it("★ 値のあるセルと AI のセルを返す", async () => {
    const sheet = await get();
    const keys = Object.keys(sheet.lines[0]!.cells).sort();
    // 値のあるセル。
    expect(keys).toEqual(expect.arrayContaining(["D16", "F16", "H16", "I16", "J16", "K16"]));
    // AI のセルは値が無くても返る (REMARK は空)。
    expect(keys).toContain("L16");
    // 人のセルで空のものは返らない。
    expect(keys).not.toContain("B16");
  });

  it("AI の記録がある欄は ai として返し、確信度を 0..1 に直す", async () => {
    const sheet = await get({
      aiFields: [["order_sheet_lines", "osl-1", "H16", "11", 42, 2]],
    });

    expect(sheet.lines[0]?.cells["H16"]).toMatchObject({
      value: "11",
      filledBy: "ai",
      // ⚠ DB は 0..100、API は 0..1。閾値 (0.7) より下なので画面は警告の色にする。
      confidence: 0.42,
      corrected: false,
    });
    // ⚠ bbox は取れない (モデルは座標を知らない)。辿れるのはページまで。
    expect(sheet.lines[0]?.cells["H16"]?.source).toEqual({ page: 2, bbox: [0, 0, 0, 0] });
    expect(sheet.confidenceThreshold).toBe(0.7);
  });

  it("人が直した AI の欄は corrected を立てる", async () => {
    const sheet = await get({
      aiFields: [["order_sheet_lines", "osl-1", "H16", "11", 90, 1]],
      corrections: [["order_sheet_lines", "osl-1", "H16"]],
    });
    expect(sheet.lines[0]?.cells["H16"]).toMatchObject({ filledBy: "ai", corrected: true });
  });

  it("CUSTOMER は取引先の名前で返す (partner_id を画面に出さない)", async () => {
    const sheet = await get({
      aiFields: [["order_sheets", "os-1", "partner_id", "partner-1", 97, 1]],
    });
    expect(sheet.header.A12).toMatchObject({ value: "顧客A", filledBy: "ai" });
  });

  /**
   * ⚠⚠ 取引先名は読み取っていないので、取り込みでは必ず**仮の取引先** (`is_active = 0`)
   *   になる。その名前 (「取引先不明」) を CUSTOMER に出さない。**空のほうが正しい。**
   */
  it("★ 人が確認していない仮の取引先は CUSTOMER に出さない", async () => {
    const sheet = await get({
      sheet: [["os-1", "ai_generated", "partner-1", "取引先不明", 0, "PO-0001", null, null, null]],
    });
    expect(sheet.header.A12).toMatchObject({ value: null });
  });

  /**
   * ⚠⚠ **GET は `issues` を返さない。**
   *   画面から「残っている不整合」を外したので、契約ごと落とした。
   *   判定 (`services/approval.ts` の `collectIssues`) は**残っていて**、いまは
   *   承認 (`POST /:caseId/approve`) だけが呼ぶ。重さの固定は services/approval.test.ts。
   */
  it("⚠⚠ GET の応答に issues は載らない", async () => {
    const sheet = await get();
    expect(sheet).not.toHaveProperty("issues");
  });
});

/** PATCH / approve 用。呼ばれた SQL と束ねた値を見る。 */
function recordingD1(options: Options = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const base = fakeD1(options);
  return {
    calls,
    client: {
      prepare(sql: string) {
        const inner = base.prepare(sql);
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return inner.bind();
          },
        };
      },
      // ⚠ D1 のトランザクション (`runBatch`)。文は prepare/bind を通るので calls に残る。
      async batch(statements: unknown[]) {
        return statements.map(() => ({ results: [], success: true, meta: {} }));
      },
    } as unknown,
  };
}

describe("PATCH /:caseId — 人が埋める欄の保存", () => {
  const patch = async (body: unknown, options?: Options) => {
    const db = recordingD1(options);
    const res = await routes.request(
      "/case-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { DB: db.client } as unknown as Bindings,
    );
    return { res, calls: db.calls };
  };

  it("ORDER SHEET が無ければ 404", async () => {
    const { res } = await patch({ corrections: [] }, { sheet: [] });
    expect(res.status).toBe(404);
  });

  /** ⚠ PO(`D12`) と SO(`F12`) は**別のセル**。1 欄にまとめない（実物でも別の番地）。 */
  it("PO と SO は別の欄として別の番地に入る", async () => {
    const { res, calls } = await patch({
      header: { D12: "PO-1", F12: "SO-2" },
      corrections: [],
    });
    expect(res.status).toBe(200);

    const update = calls.find((c) => /^\s*update "order_sheets" set "cells_json"/i.test(c.sql))!;
    const written = JSON.parse(String(update.params[0])) as Record<string, string>;
    expect(written.D12).toBe("PO-1");
    expect(written.F12).toBe("SO-2");
  });

  /**
   * ⚠⚠ **ヘッダも地図に畳み込む**。送られた欄だけを差し替え、
   *   もう片方は**そのまま持ち越す**（明細のセルと同じ仕組み）。
   */
  it("⚠ 片方だけ送っても、もう片方を消さない", async () => {
    const { res, calls } = await patch({ header: { F12: "SO-9" }, corrections: [] });
    expect(res.status).toBe(200);

    const update = calls.find((c) => /^\s*update "order_sheets" set "cells_json"/i.test(c.sql))!;
    const written = JSON.parse(String(update.params[0])) as Record<string, string>;
    expect(written.F12).toBe("SO-9");
    // 元から入っていた発注No は残る。
    expect(written.J7).toBe("PO-0001");
  });

  it("CUSTOMER は保存しない (画面に出ているのは名前、列は partner_id)", async () => {
    const { calls } = await patch({ header: { A12: "顧客B" }, corrections: [] });
    const updates = calls.filter((c) => /^\s*update "order_sheets" set/i.test(c.sql));
    // 保存する欄が 1 つも無いので、set 句のある update は status の 1 本だけ。
    expect(updates.every((c) => !c.params.includes("顧客B"))).toBe(true);
  });

  it("⚠ corrections を ai_field_corrections に 1 件 1 行で残す (正答率の分母)", async () => {
    const { calls } = await patch({
      lines: [{ lineId: "osl-1", cells: { "H16": "12" } }],
      corrections: [
        {
          // ⚠ 直した欄の名前は**セルの鍵**（明細の場合）。
          fieldKey: "H16",
          lineId: "osl-1",
          previousValue: "11",
          newValue: "12",
          // ⚠ API の語。DB の enum は "ocr"。
          errorKind: "ocr",
        },
        {
          fieldKey: "D16",
          lineId: "osl-1",
          previousValue: "A",
          newValue: "B",
          // ⚠ API の "missed" は DB では "missing"。素通しすると CHECK 違反。
          errorKind: "missed",
        },
      ],
    });

    const inserts = calls.filter((c) => /insert into "ai_field_corrections"/i.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[1]!.params).toContain("missing");
    expect(inserts[1]!.params).not.toContain("missed");
  });

  /**
   * ★★ **打ったセルだけを畳み込み、ほかのセルはそのまま残す。**
   *
   * ⚠⚠ ここが壊れると、人が打った原型No・POLISH・メッキ・ロゴが**保存のたびに消える**。
   *   画面は打ったセルしか送ってこないので、残りを持ち越すのは保存側の仕事。
   */
  it("★ 打ったセルだけを差し替え、ほかは残す", async () => {
    const { res, calls } = await patch({
      lines: [{ lineId: "osl-1", cells: { "J16": "SET" } }],
      corrections: [],
    });
    expect(res.status).toBe(200);

    const update = calls.find((c) => /^\s*update "order_sheet_lines" set/i.test(c.sql))!;
    expect(update.sql).toMatch(/"cells_json"/);
    const written = JSON.parse(String(update.params[0])) as Record<string, string>;
    expect(written["J16"]).toBe("SET");
    // 元から入っていたセルは残る。
    expect(written["D16"]).toBe("CIC-0001");
    expect(written["F16"]).toBe("リング");
  });

  /** ⚠ 空にされたセルは**鍵ごと消す**（`null` を溜めない）。 */
  it("⚠ 空にされたセルは地図から消える", async () => {
    const { res, calls } = await patch({
      lines: [{ lineId: "osl-1", cells: { "F16": null } }],
      corrections: [],
    });
    expect(res.status).toBe(200);

    const update = calls.find((c) => /^\s*update "order_sheet_lines" set/i.test(c.sql))!;
    const written = JSON.parse(String(update.params[0])) as Record<string, string>;
    expect("F16" in written).toBe(false);
    expect(written["D16"]).toBe("CIC-0001");
  });

  it("⚠ 工程表は production_plan_steps に書かない (C4:E10 のセルとして cells_json に入る)", async () => {
    const { res, calls } = await patch({
      lines: [{ lineId: "osl-1", cells: { "L16": "XX 0001" } }],
      corrections: [],
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => /"production_plan_steps"/i.test(c.sql))).toBe(false);
  });

  it("★ 取り込み中の空の枠 (lineId が空) は保存に混ざらない", async () => {
    const { res, calls } = await patch({
      lines: [{ lineId: "", cells: { "H16": "12" } }],
      corrections: [],
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => /^\s*update "order_sheet_lines" set/i.test(c.sql))).toBe(false);
  });

  it("人が見はじめた印を付ける (in_review)", async () => {
    const { calls } = await patch({ header: { J5: "2026-12-01" }, corrections: [] });
    expect(calls.some((c) => c.params.includes("in_review"))).toBe(true);
  });
});

describe("POST /:caseId/approve — 承認の条件", () => {
  const approve = async (options?: Options) => {
    const db = recordingD1(options);
    const res = await routes.request("/case-1/approve", { method: "POST" }, {
      DB: db.client,
    } as unknown as Bindings);
    return { res, body: (await res.json()) as unknown, calls: db.calls };
  };

  /**
   * 人が確認して空欄でいいとした欄は、空欄のまま通す。
   * ⚠⚠ **以前はここが 409 だった。** 6 欄がすべて warning になったので 200 で通り、
   *   `released` まで進む。残った warning は返り値と `order_sheet_issues` の両方に残り、
   *   画面は流したあとも不整合パネルに出し続ける。
   */
  it("人が埋める欄が空でも 200 で通し、残った警告を返す", async () => {
    const { res, body, calls } = await approve();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "released" });
    expect((body as { blockers: unknown[] }).blockers).toEqual([]);
    expect((body as { warnings: unknown[] }).warnings.length).toBeGreaterThan(0);
    // 画面が後からでも見られるよう、判定の結果を残す (severity 非依存で全件)。
    expect(calls.some((c) => /insert into "order_sheet_issues"/i.test(c.sql))).toBe(true);
    // 通したのだから released にする。**ここは不可逆点**。
    expect(calls.some((c) => c.params.includes("released"))).toBe(true);
  });

  it("すでに released なら二度流さない (不可逆点)", async () => {
    const { res, body } = await approve({
      sheet: [["os-1", "released", "partner-1", "顧客A", "PO-0001", null, null, null]],
    });
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "already_released" });
  });

  it("ORDER SHEET が無ければ 404", async () => {
    const { res } = await approve({ sheet: [] });
    expect(res.status).toBe(404);
  });
});

/**
 * ★ 代表の図を 1 枚だけ外す (画面のゴミ箱)。
 *
 * ⚠⚠ **人が外した記録を持つのは `order_sheet_line_photos.deleted_at` だけ。**
 *   `files` は降ろさない (1 枚の依頼書が複数の明細に結ばれるので、関係のない明細の
 *   Picture まで消える)。
 * ⚠ 可否の判定は API の 1 か所。画面は 409 / 404 の理由を出すだけ。
 */
describe("DELETE /:caseId/lines/:lineId/photos/:photoId — 代表の図を外す", () => {
  const remove = async (photoId: string, options?: Options) => {
    const db = recordingD1({ photos: PHOTOS, ...options });
    const res = await routes.request(
      `/case-1/lines/osl-1/photos/${photoId}`,
      { method: "DELETE" },
      { DB: db.client } as unknown as Bindings,
    );
    return { res, calls: db.calls };
  };

  const photoUpdates = (calls: { sql: string; params: unknown[] }[]) =>
    calls.filter((c) => /^\s*update "order_sheet_line_photos" set/i.test(c.sql));

  it("外すと deleted_at が入り、代表が**残った先頭**に付け替わる", async () => {
    const { res, calls } = await remove("osp-1");

    expect(res.status).toBe(200);
    // ⚠ 返るのは ORDER SHEET 全体 (PATCH と同じ形)。画面はこれで締められる。
    orderSheetSchema.parse(await res.json());

    expect(photoUpdates(calls)).toHaveLength(1);
    const line = calls.find((c) => /^\s*update "order_sheet_lines" set/i.test(c.sql))!;
    expect(line.sql).toMatch(/"photo_file_id"/);
    // 残った先頭 (osp-2) の絵が代表になる。付け替えないと消した絵が欄に残る。
    expect(line.params).toContain("file-2");
  });

  it("⚠ 最後の 1 枚を外したら代表は空になる (全部外したら空が正しい)", async () => {
    const { res, calls } = await remove("osp-1", {
      photos: [PHOTOS[0]!],
    });

    expect(res.status).toBe(200);
    const line = calls.find((c) => /^\s*update "order_sheet_lines" set/i.test(c.sql))!;
    expect(line.sql).toMatch(/"photo_file_id" = \?/);
    // ⚠ 値は bind で渡る。1 つ目が photo_file_id。
    expect(line.params[0]).toBeNull();
  });

  it("⚠ 二度目も 200 (冪等)。消し直さない", async () => {
    const { res, calls } = await remove("osp-1", {
      photos: [{ ...PHOTOS[0]!, deletedAt: 1 }, PHOTOS[1]!],
    });

    expect(res.status).toBe(200);
    // ⚠ 既に外れているので書き込みは 1 本も出ない (deleted_at を上書きしない)。
    expect(photoUpdates(calls)).toEqual([]);
  });

  it("無い写真は 404", async () => {
    const { res } = await remove("osp-9");
    expect(res.status).toBe(404);
  });

  it("⚠ この ORDER SHEET の明細でなければ 404", async () => {
    const db = recordingD1({ photos: PHOTOS, lines: [] });
    const res = await routes.request("/case-1/lines/osl-9/photos/osp-1", { method: "DELETE" }, {
      DB: db.client,
    } as unknown as Bindings);
    expect(res.status).toBe(404);
  });

  it("released では 409 (現場が動いているので根拠の絵も動かさない)", async () => {
    const { res, calls } = await remove("osp-1", {
      sheet: [["os-1", "released", "partner-1", "顧客A", 1, "PO-0001", null, null, null]],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "released" });
    expect(photoUpdates(calls)).toEqual([]);
  });

  it("⚠⚠ 原本 (files) は降ろさない", async () => {
    const { calls } = await remove("osp-1");
    expect(calls.some((c) => /update "files" set/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /delete from "files"/i.test(c.sql))).toBe(false);
  });

  it("⚠ ai_field_corrections には載せない (欄は 1 つのまま。正答率の分母を水増ししない)", async () => {
    const { calls } = await remove("osp-1");
    expect(calls.some((c) => /insert into "ai_field_corrections"/i.test(c.sql))).toBe(false);
  });
});

/**
 * ★ 代表の図を 1 枚足す (画面の upload アイコン)。ゴミ箱と対。
 *
 * ⚠ 受けるのは jpeg / png だけ。xlsx に埋め込めるのがその 2 つだけ。
 * ⚠ 形式は**中身の先頭のバイト**で決める (申告の content-type は信じない)。
 */
describe("POST /:caseId/lines/:lineId/photos — 代表の図を足す", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  const upload = async (
    body: { bytes: Uint8Array<ArrayBuffer>; type: string; name?: string } | null,
    options?: Options,
  ) => {
    const db = recordingD1({ photos: PHOTOS, ...options });
    const puts: { key: string; contentType: unknown }[] = [];
    const bucket = {
      async put(key: string, _body: unknown, init?: { httpMetadata?: { contentType?: string } }) {
        puts.push({ key, contentType: init?.httpMetadata?.contentType });
      },
    };
    const form = new FormData();
    if (body) {
      form.set("file", new File([body.bytes], body.name ?? "photo.jpg", { type: body.type }));
    }
    const res = await routes.request(
      "/case-1/lines/osl-1/photos",
      { method: "POST", body: form },
      { DB: db.client, FILES_BUCKET: bucket } as unknown as Bindings,
    );
    return { res, calls: db.calls, puts };
  };

  const photoInsert = (calls: { sql: string; params: unknown[] }[]) =>
    calls.find((c) => /insert into "order_sheet_line_photos"/i.test(c.sql));
  const lineUpdate = (calls: { sql: string; params: unknown[] }[]) =>
    calls.find((c) => /^\s*update "order_sheet_lines" set/i.test(c.sql));

  it("jpeg を足すと、R2 と files に預けて明細の**末尾**に 1 行入る", async () => {
    const { res, calls, puts } = await upload({ bytes: JPEG, type: "image/jpeg" });

    expect(res.status).toBe(200);
    // ⚠ 返るのは ORDER SHEET 全体 (DELETE と同じ形)。
    orderSheetSchema.parse(await res.json());

    // ⚠⚠ 鍵は `photos/manual/`。`photos/spec/` にすると読み直しで依頼書の絵として拾われる。
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^photos\/manual\/[^/]+\.jpg$/);
    expect(puts[0]!.contentType).toBe("image/jpeg");

    const file = calls.find((c) => /insert into "files"/i.test(c.sql))!;
    expect(file.params).toContain("item_photo");
    expect(file.params).toContain("upload");

    const photo = photoInsert(calls)!;
    // 既に 0 / 1 があるので 2 (末尾)。
    expect(photo.params).toContain(2);
    // ⚠ 生きている先頭 (file-1) が代表のまま。足した絵で差し替えない。
    expect(lineUpdate(calls)!.params[0]).toBe("file-1");
  });

  it("png も受ける (鍵の拡張子も png)", async () => {
    const { res, puts } = await upload({ bytes: PNG, type: "image/png", name: "photo.png" });
    expect(res.status).toBe(200);
    expect(puts[0]!.key).toMatch(/\.png$/);
    expect(puts[0]!.contentType).toBe("image/png");
  });

  it("⚠ 生きている絵が無ければ、足した絵が代表になる (全部外したあとの差し替え)", async () => {
    const { res, calls } = await upload(
      { bytes: JPEG, type: "image/jpeg" },
      { photos: PHOTOS.map((photo) => ({ ...photo, deletedAt: 1 })) },
    );

    expect(res.status).toBe(200);
    const [photoId, , fileId] = photoInsert(calls)!.params;
    expect(typeof photoId).toBe("string");
    expect(lineUpdate(calls)!.params[0]).toBe(fileId);
    // ⚠ 消した行も数えて末尾に置く (墓標の sort_key と重ねない)。
    expect(photoInsert(calls)!.params).toContain(2);
  });

  it("⚠ jpeg / png 以外は 415。何も預けない", async () => {
    const { res, calls, puts } = await upload({
      bytes: new TextEncoder().encode("not an image"),
      type: "text/plain",
      name: "memo.txt",
    });

    expect(res.status).toBe(415);
    expect(puts).toEqual([]);
    expect(photoInsert(calls)).toBeUndefined();
  });

  it("⚠ 名前と申告が jpeg でも、中身が違えば 415 (xlsx を壊さない)", async () => {
    const { res } = await upload({
      bytes: new TextEncoder().encode("GIF89a...."),
      type: "image/jpeg",
    });
    expect(res.status).toBe(415);
  });

  it("released では 409。R2 にも files にも書かない", async () => {
    const { res, calls, puts } = await upload(
      { bytes: JPEG, type: "image/jpeg" },
      { sheet: [["os-1", "released", "partner-1", "顧客A", 1, "PO-0001", null, null, null]] },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "released" });
    expect(puts).toEqual([]);
    expect(calls.some((c) => /insert into "files"/i.test(c.sql))).toBe(false);
  });

  it("⚠ この ORDER SHEET の明細でなければ 404", async () => {
    const { res, puts } = await upload({ bytes: JPEG, type: "image/jpeg" }, { lines: [] });
    expect(res.status).toBe(404);
    expect(puts).toEqual([]);
  });

  it("file が無ければ 400", async () => {
    const { res } = await upload(null);
    expect(res.status).toBe(400);
  });

  it("⚠ ai_field_corrections には載せない (欄は 1 つのまま)", async () => {
    const { calls } = await upload({ bytes: JPEG, type: "image/jpeg" });
    expect(calls.some((c) => /insert into "ai_field_corrections"/i.test(c.sql))).toBe(false);
  });
});

describe("★ GET /:caseId/xlsx — ORDER SHEET を xlsx で出す", () => {
  /** xlsx は R2 にも残す (残せなくてもダウンロードは通る)。 */
  const envOf = (options?: Options) =>
    ({
      DB: fakeD1(options),
      /*
       * ⚠ xlsx に写真を貼るようになったので `get` も要る (`readBytes`)。
       *   ⚠⚠ **`storeExport` の try/catch の外で呼ばれる**ので、無いと 500 になる。
       */
      FILES_BUCKET: { put: async () => ({}), get: async () => null },
    }) as unknown as Bindings;

  it("xlsx を返す。⚠ ファイル名に固有名詞を入れない", async () => {
    const res = await routes.request("/case-1/xlsx", {}, envOf());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // 案件番号か社内番号だけ (取引先名から作る caseLabel は使わない)。
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="ORDER_SHEET_[A-Za-z0-9_-]+\.xlsx"$/,
    );

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);
  });

  /**
   * ★★ **画面で打った文字が、保存 → 読み直し → xlsx の順に 1 文字も変わらない。**
   *
   * ⚠⚠ 日本語・タイ語が落ちる経路が無いことを**経路ごと**確かめる
   *   （PATCH の契約 → writer → `cells_json` → reader → `toXlsxInput()` → xlsx）。
   * ⚠ 偽の D1 は SQL を実行しないので、PATCH が書いた `cells_json` を拾って次の GET に渡す。
   */
  it("★★ 日本語・タイ語の手入力が PATCH → D1 → GET → xlsx で同じ文字になる", async () => {
    const typedLine = {
      F16: "鋳造 SV950",
      F18: "ชุบ K18PG/P +RH",
      G16: "(ダイヤモンド) 1.0mm ×3",
      H16: "11号",
      I16: "3個",
      K16: "1/2/99",
      L16: "至急 ด่วน",
    };
    const typedHeader = { J5: "10月上旬", F12: "ใบสั่ง 1" };

    // ① 画面の保存（PATCH）。
    const db = recordingD1();
    const saved = await routes.request(
      "/case-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          header: typedHeader,
          lines: [{ lineId: "osl-1", cells: typedLine }],
          corrections: [],
        }),
      },
      { DB: db.client } as unknown as Bindings,
    );
    expect(saved.status).toBe(200);

    // ② D1 に入った `cells_json`（偽の D1 は実行しないので、書いた値を拾う）。
    const lineJson = String(
      db.calls.find((c) => /^\s*update "order_sheet_lines" set/i.test(c.sql))!.params[0],
    );
    const headerJson = String(
      db.calls.find((c) => /^\s*update "order_sheets" set "cells_json"/i.test(c.sql))!.params[0],
    );
    const written = JSON.parse(lineJson) as Record<string, string>;
    for (const [ref, text] of Object.entries(typedLine)) expect(written[ref]).toBe(text);

    const stored: Options = {
      sheet: [["os-1", "in_review", "partner-1", "顧客A", 1, headerJson]],
      lines: [["osl-1", 1, null, lineJson]],
    };

    // ③ 読み直し（画面に出る値）。
    const sheet = await get(stored);
    for (const [ref, text] of Object.entries(typedLine)) {
      expect(sheet.lines[0]!.cells[ref]!.value).toBe(text);
    }
    expect(sheet.header.J5!.value).toBe("10月上旬");
    expect(sheet.header.F12!.value).toBe("ใบสั่ง 1");

    // ④ xlsx（画面の文字がそのまま。ヘッダは印字の接頭辞 ＋ 打った文字）。
    const res = await routes.request("/case-1/xlsx", {}, envOf(stored));
    expect(res.status).toBe(200);
    const xml = await sheetXml(new Uint8Array(await res.arrayBuffer()));
    for (const [ref, text] of Object.entries(typedLine)) {
      expect({ ref, text: cellOf(xml, ref) }).toEqual({ ref, text });
    }
    expect(cellOf(xml, "J5")).toBe("SHIP : 10月上旬");
    expect(cellOf(xml, "F12")).toBe("SO: ใบสั่ง 1");
    // ⚠ 数に読めない QTY は文字のセル（消さない）。
    expect(isTextCell(xml, "I16")).toBe(true);
    // ⚠ DATE は画面と xlsx で同じ文字（「いま出したら入る日」を実例の書き方で）。
    expect(cellOf(xml, "J12")).toBe(`DATE : ${String(sheet.header.J12!.value)}`);
  });

  it("ORDER SHEET がまだ無い案件でも空の枠を出せる", async () => {
    // ⚠ 読み取りの途中でも「紙の形」を見せられることに意味がある。
    const res = await routes.request("/case-1/xlsx", {}, envOf({ sheet: [] }));
    expect(res.status).toBe(200);
  });
});
