import { describe, expect, it } from "vitest";
import type { Bindings } from "../../../shared/hono";
import { routes } from "./routes";

/**
 * `GET /documents` と `POST /documents/:documentId/reextract` の振る舞いを固定する。
 *
 * ⚠⚠ **一番大事なのは `originalUrl` の形。** ここが空だと案件詳細の画面が「原本は準備中」の
 *   ままになる。**署名付き URL は作らない**方針なので、認証付きの既存ルートの
 *   相対パスを返しているかを固定する。
 * ⚠ **feature の `routes` を直接叩く。** path が `/api/` 始まりでないので authMiddleware は
 *   素通りし、トークンを用意しなくてよい。
 * ⚠ `@cloudflare/vitest-pool-workers` は使えない (vitest 5 と peer が合わない) ので、
 *   `app.request(path, init, env)` に偽の Bindings を渡す node のテストにする。
 * ⚠ 固有名詞を書かない。品番も帳票の ID も架空のコード。
 */

/** drizzle が `.raw()` で期待する**値の配列**を、select の並びどおりに作る。 */
const DOCUMENT_ROW = [
  "doc-1", // po_documents.id
  "file-1", // po_documents.file_id
  "purchase_order", // po_documents.doc_kind
  "parsed", // po_documents.status
  1_700_000_000_000, // po_documents.received_at
  null, // files.page_count (PoC では常に空)
];

interface FakeD1Options {
  /** `SELECT … FROM po_documents LEFT JOIN files` が返す行。 */
  documents?: unknown[][];
  /** 帳票 1 通の逆引き (reextract の入口)。空で「その帳票が無い」。 */
  document?: unknown[][];
  /** `ai_jobs` から引ける案件。空で「案件が引けない」。 */
  caseRows?: unknown[][];
  /** その案件の ORDER SHEET の状態 (削除の可否を決める)。 */
  orderSheet?: unknown[][];
}

function fakeD1(options: FakeD1Options = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const batches: { sql: string; params: unknown[] }[][] = [];

  function rowsFor(sql: string): unknown[][] {
    if (/from "ai_jobs"/i.test(sql)) return options.caseRows ?? [["case-1"]];
    // 一覧は files を left join する。逆引き (reextract) は join しない。
    if (/from "po_documents"/i.test(sql) && /left join "files"/i.test(sql)) {
      return options.documents ?? [DOCUMENT_ROW];
    }
    if (/from "po_documents"/i.test(sql)) {
      return options.document ?? [["doc-1", "file-1", "purchase_order"]];
    }
    if (/from "order_sheets"/i.test(sql)) return options.orderSheet ?? [];
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
            __statement: { sql, params },
            run: async () => ({ results: [], success: true, meta: {} }),
          };
        },
      };
    },
    /** ⚠ 削除は「帳票 → 発注書 → 依頼書」を 1 つのトランザクションで降ろす。 */
    async batch(statements: { __statement?: { sql: string; params: unknown[] } }[]) {
      batches.push(statements.map((st) => st.__statement ?? { sql: "?", params: [] }));
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  };
  return { client, calls, batches };
}

const envWith = (client: unknown) =>
  ({ DB: client, JOBS_QUEUE: { send: async () => {} } }) as unknown as Bindings;

describe("GET /documents", () => {
  it("caseId が無ければ空で返す (D1 を引かない)", async () => {
    const { client, calls } = fakeD1();
    const res = await routes.request("/documents", {}, envWith(client));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caseId: "", documents: [] });
    expect(calls).toHaveLength(0);
  });

  it("originalUrl に認証付きの既存ルートを返す (署名付き URL は作らない)", async () => {
    const { client } = fakeD1();
    const res = await routes.request("/documents?caseId=case-1", {}, envWith(client));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: { originalUrl: string }[] };
    // ⚠ ここが null だと案件詳細の画面が「原本は準備中」のままになる。
    expect(body.documents[0]?.originalUrl).toBe("/api/files/file-1/original");
  });

  it("判定していない様式を名乗らない (formPattern は null)", async () => {
    const { client } = fakeD1();
    const res = await routes.request("/documents?caseId=case-1", {}, envWith(client));

    const body = (await res.json()) as {
      documents: { formPattern: string | null; extractionStatus: string; receivedOn: string }[];
    };
    expect(body.documents[0]?.formPattern).toBeNull();
    expect(body.documents[0]?.extractionStatus).toBe("parsed");
    expect(body.documents[0]?.receivedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("POST /documents/:documentId/reextract", () => {
  it("積み直して 202 と jobId を返す", async () => {
    const { client, calls } = fakeD1();
    const res = await routes.request(
      "/documents/doc-1/reextract",
      { method: "POST" },
      envWith(client),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "accepted" });
    // ⚠⚠ **ここで論理削除しない。** 以前は「先に消してから積む」だったので、
    //   積み直しが失敗すると**案件から帳票が消えたままになる**。
    //   取り下げは読めてから、書き込みと同じ batch で行う (document-writer.ts)。
    expect(calls.some((c) => /^\s*update "purchase_orders"/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /^\s*update "revision_requests"/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /insert into "ai_jobs"/i.test(c.sql))).toBe(true);
    // 積むのは 1 本の読み取りジョブだけ (種類で分かれない)。
    expect(calls.some((c) => c.params.includes("doc_extract"))).toBe(true);
  });

  it("帳票が無ければ 404", async () => {
    const { client } = fakeD1({ document: [] });
    const res = await routes.request(
      "/documents/doc-x/reextract",
      { method: "POST" },
      envWith(client),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("案件が逆引きできなければ 409 (結果の置き場所が決まらない)", async () => {
    const { client } = fakeD1({ caseRows: [] });
    const res = await routes.request(
      "/documents/doc-1/reextract",
      { method: "POST" },
      envWith(client),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "case_unknown" });
  });
});

describe("★ DELETE /documents/:documentId — 帳票の取り消し", () => {
  it("論理削除して、ORDER SHEET を組み直すジョブを積む", async () => {
    const { client, calls, batches } = fakeD1();
    const res = await routes.request("/documents/doc-1", { method: "DELETE" }, envWith(client));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, caseId: "case-1" });

    const written = batches.at(-1) ?? [];
    // ⚠ **物理削除にしない** (誰が何をしたかの記録が残らない)。
    expect(written.some((st) => /delete from/i.test(st.sql))).toBe(false);
    // 帳票から作った行も一緒に降ろす。
    expect(written.some((st) => /update "purchase_orders" set .*"deleted_at"/i.test(st.sql))).toBe(
      true,
    );
    expect(
      written.some((st) => /update "revision_requests" set .*"deleted_at"/i.test(st.sql)),
    ).toBe(true);
    expect(written.some((st) => /update "po_documents" set .*"deleted_at"/i.test(st.sql))).toBe(
      true,
    );
    // 残った帳票で組み直す。
    expect(calls.some((c) => c.params.includes("order_sheet_generate"))).toBe(true);
  });

  it("⚠ 現場に流したあと (released) の案件では断る (409)", async () => {
    // released は不可逆点。根拠の帳票だけ抜けると ORDER SHEET が宙に浮く。
    const { client, batches } = fakeD1({ orderSheet: [["released"]] });
    const res = await routes.request("/documents/doc-1", { method: "DELETE" }, envWith(client));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "released" });
    // 1 文も書かないこと。
    expect(batches).toHaveLength(0);
  });

  it("帳票が無ければ 404", async () => {
    const { client } = fakeD1({ document: [] });
    const res = await routes.request("/documents/doc-x", { method: "DELETE" }, envWith(client));
    expect(res.status).toBe(404);
  });

  it("案件が引けなければ 409 (結果の置き場所が決まらない)", async () => {
    const { client } = fakeD1({ caseRows: [] });
    const res = await routes.request("/documents/doc-1", { method: "DELETE" }, envWith(client));
    expect(res.status).toBe(409);
  });
});
