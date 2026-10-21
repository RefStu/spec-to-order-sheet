import { describe, expect, it } from "vitest";
import type { Bindings } from "../../../shared/hono";
import { routes } from "./routes";

/**
 * 印字由来の欄の正答率。
 *
 * ⚠⚠ **分母は AI が埋めた欄だけ。** 人が埋める欄が混ざると、合格条件の
 *   数字が実際より良くも悪くも出る。
 * ⚠ **合否は返さない。** 合否の判定は持たず、率だけを出す。
 * ⚠ SQL は実行しない偽の D1。確かめるのは数え方。
 */

type Report = {
  overall: { accepted: number; corrected: number; rate: number | null };
  byField: { fieldKey: string; accepted: number; corrected: number; rate: number | null }[];
  byErrorKind: { errorKind: string; count: number }[];
};

function fakeD1(aiFields: unknown[][], corrections: unknown[][]) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          const rows = /from "ai_extraction_fields"/i.test(sql)
            ? aiFields
            : /from "ai_field_corrections"/i.test(sql)
              ? corrections
              : [];
          return {
            raw: async () => rows,
            all: async () => ({ results: rows, success: true, meta: {} }),
            run: async () => ({ results: [], success: true, meta: {} }),
          };
        },
      };
    },
  };
}

const get = async (aiFields: unknown[][], corrections: unknown[][] = []) => {
  const res = await routes.request("/accuracy", {}, {
    DB: fakeD1(aiFields, corrections),
  } as unknown as Bindings);
  expect(res.status).toBe(200);
  return (await res.json()) as Report;
};

describe("GET /accuracy", () => {
  it("1 件も無ければ率は null (「0%」と「まだ測っていない」は別物)", async () => {
    const report = await get([]);
    expect(report.overall).toEqual({ accepted: 0, corrected: 0, rate: null });
    // AI の欄は全部出す (読み落としている欄がどれか分かるように)。
    // ⚠ 数は `ORDER_SHEET_FIELDS` が決める。ここは「全部出る」ことだけを見る。
    expect(report.byField).toHaveLength(8);
  });

  it("そのまま採用 ÷ (そのまま採用 + 人が直した)", async () => {
    const report = await get(
      [
        // ⚠ 明細の列は**セルの鍵**。`"H:0"` = 紙の H 列 (Size) の値の行。
        ["order_sheet_lines", "osl-1", "H:0"],
        ["order_sheet_lines", "osl-2", "H:0"],
        ["order_sheet_lines", "osl-3", "H:0"],
        ["order_sheet_lines", "osl-4", "H:0"],
      ],
      [["order_sheet_lines", "osl-1", "H:0", "ocr"]],
    );

    expect(report.overall).toEqual({ accepted: 3, corrected: 1, rate: 0.75 });
    expect(report.byField.find((f) => f.fieldKey === "size")).toMatchObject({
      accepted: 3,
      corrected: 1,
      rate: 0.75,
    });
    expect(report.byErrorKind).toEqual([{ errorKind: "ocr", count: 1 }]);
  });

  it("人が埋める欄は数えない", async () => {
    const report = await get([
      // AI の欄 (Size)。
      ["order_sheet_lines", "osl-1", "H:0"],
      // 人の欄 (Code / PO)。記録があっても分母に入れない。
      ["order_sheet_lines", "osl-1", "B:0"],
      ["order_sheets", "os-1", "po_no"],
    ]);
    expect(report.overall.accepted).toBe(1);
  });

  /**
   * ⚠⚠ **出荷日は 2 つとも人の欄になった** (明細の Ship date は出どころが確定できないので
   *   読み取りをやめた)。**どちらも分母に入らない。**
   * ⚠ 突き合わせは (表, 列) の組でするので、**表が違えば別の欄**。明細はセルの鍵
   *   (`"K:0"`)、ヘッダは物理の列名 (`ship_date`) と形も違う。
   *   `ORDER_SHEET_FIELDS` の `by` を変えたときに、ここが黙って混ざらないことを固定する。
   */
  it("出荷日の 2 欄は、どちらも人の欄なので数えない", async () => {
    const report = await get([
      // AI の欄 (これだけが分母に入る)。
      ["order_sheet_lines", "osl-1", "H:0"],
      // 人の欄 (明細の Ship date)。
      ["order_sheet_lines", "osl-1", "K:0"],
      // 人の欄 (営業が決めるヘッダの SHIP)。
      ["order_sheets", "os-1", "ship_date"],
    ]);
    expect(report.overall.accepted).toBe(1);
    expect(report.byField.find((f) => f.fieldKey === "shipDate")).toBeUndefined();
    expect(report.byField.find((f) => f.fieldKey === "ship")).toBeUndefined();
  });
});

describe("★ 発注書分類 — 様式と指示文", () => {
  /** SQL は実行せず、どの表を引いたかで決まった行を返す。batch は文を覚えるだけ。 */
  function fakeDb(rows: { profiles?: unknown[][]; prompts?: unknown[][] } = {}) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const batches: { sql: string; params: unknown[] }[][] = [];

    const client = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            const statement = { sql, params };
            calls.push(statement);
            const values = /from "partner_form_profiles"/i.test(sql)
              ? (rows.profiles ?? [])
              : /from "ai_prompts"/i.test(sql)
                ? (rows.prompts ?? [])
                : [];
            return {
              raw: async () => values,
              all: async () => ({ results: values, success: true, meta: {} }),
              run: async () => ({ results: [], success: true, meta: {} }),
              __statement: statement,
            };
          },
        };
      },
      async batch(statements: { __statement?: { sql: string; params: unknown[] } }[]) {
        batches.push(statements.map((s) => s.__statement ?? { sql: "?", params: [] }));
        return statements.map(() => ({ results: [], success: true, meta: {} }));
      },
    };
    return { client, calls, batches };
  }

  const envOf = (client: unknown) => ({ DB: client }) as unknown as Bindings;

  it("様式が無くても 200 で空の一覧を返す", async () => {
    const { client } = fakeDb();
    const res = await routes.request("/form-profiles", {}, envOf(client));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profiles: [], prompts: [] });
  });

  it("様式を足す (code が重なったら 409)", async () => {
    const { client, calls } = fakeDb();
    const res = await routes.request(
      "/form-profiles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "P1", name: "様式パターン①", docKind: "mixed" }),
      },
      envOf(client),
    );

    expect(res.status).toBe(201);
    expect(calls.some((c) => /insert into "partner_form_profiles"/i.test(c.sql))).toBe(true);
  });

  it("⚠⚠ 指示文は上書きせず、版を足して前の版を降ろす (同じトランザクションで)", async () => {
    // 既にある版 (id, version) を返す。
    const { client, batches } = fakeDb({ prompts: [["p-old", 1]] });
    const res = await routes.request(
      "/prompts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "purchase_order", body: "新しい指示文" }),
      },
      envOf(client),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 2 });

    const written = batches.at(-1) ?? [];
    // 新しい版を入れて、前の版は **消さずに降ろす**。
    expect(written[0]?.sql).toMatch(/insert into "ai_prompts"/i);
    expect(written[1]?.sql).toMatch(/update "ai_prompts"/i);
    expect(written.some((s) => /delete from "ai_prompts"/i.test(s.sql))).toBe(false);
  });

  it("形が違う指示文は 400 (空の本文で使用中にしない)", async () => {
    const { client } = fakeDb();
    const res = await routes.request(
      "/prompts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "purchase_order", body: "" }),
      },
      envOf(client),
    );
    expect(res.status).toBe(400);
  });
});
