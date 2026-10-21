import { describe, expect, it } from "vitest";
import type { Bindings } from "../../../shared/hono";
import { LIST_SQL } from "../services/case-service";
import { routes } from "./routes";

/**
 * `POST /api/cases` と `PATCH /api/cases/:caseId` の振る舞いを固定する。
 *
 * ⚠⚠ **POST が空の本文で 201 を返すことが、この feature で一番大事な検査。**
 *   取り込みはアップロードの時点で `{}` のまま呼ぶので、ここが 400 に
 *   なると「発注書をアップロード」が丸ごと 502 で死ぬ (しかも R2 に書いたファイルは
 *   巻き戻らない)。
 * ⚠ **feature の `routes` を直接叩く。** `app/routes.gen.ts` は境界ルールで features から
 *   import できない。path が `/api/` 始まりでないので authMiddleware は素通りし、
 *   トークンを用意しなくてよい。
 * ⚠ `@cloudflare/vitest-pool-workers` は使えない (vitest 5 と peer が合わない) ので、
 *   `app.request(path, init, env)` に偽の Bindings を渡す node のテストにする。
 * ⚠ 固有名詞を書かない。取引先は「顧客A」。
 */

interface FakeD1Options {
  /** `SELECT id FROM partners …` が返す行。null で「見つからない」。 */
  partner?: { id: string } | null;
  /** `SELECT … FROM cases …` (getCase) が返す行。null で「案件が無い」。 */
  caseRow?: Record<string, unknown> | null;
  /** UPDATE で UNIQUE 違反を起こさせる。 */
  uniqueViolationOnUpdate?: boolean;
  /** `LIST_SQL` が返す行 (listCases)。 */
  listRows?: Record<string, unknown>[];
  /** `SELECT id, case_id, status FROM ai_jobs WHERE id = ?1` が返す行。null で「ジョブが無い」。 */
  jobRow?: Record<string, unknown> | null;
  /** ai_jobs の件数 (getJobStatus の集約)。 */
  jobCounts?: Record<string, unknown> | null;
  /** その案件に ORDER SHEET があるか。 */
  orderSheetRow?: { id: string } | null;
}

/** LIST_SQL の 1 行ぶんの既定値。**列名は case-service.ts の ListRow と同じにする。** */
const LIST_ROW = {
  case_id: "case-1",
  case_no: "CS-0001",
  title: null,
  spec_no: "SPC-0001",
  partner_name: "顧客A",
  customer_po_no: "PO-0001",
  po_count: 1,
  rr_count: 0,
  order_sheet_status: "ai_generated",
  ship_date: null,
  updated_at: 1_700_000_000_000,
  queued_count: 0,
  running_count: 0,
  failed_count: 0,
  job_count: 0,
};

/** D1 の代わり。**SQL は実行せず**、どの表を引いたかだけ見て決まった行を返す。 */
function fakeD1(options: FakeD1Options = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const partner = options.partner === undefined ? null : options.partner;
  const caseRow =
    options.caseRow === undefined
      ? {
          case_id: "case-1",
          case_no: null,
          title: null,
          spec_no: "SPC-0001",
          status: "open",
          updated_at: 1_700_000_000_000,
          partner_name: "顧客A",
        }
      : options.caseRow;

  function firstFor(sql: string): unknown {
    if (/from partners/i.test(sql)) return partner;
    // ⚠ ai_jobs は 2 種類引く。集約のほうは COUNT(*) があるかどうかで見分ける。
    if (/from ai_jobs/i.test(sql)) {
      if (/count\(\*\)/i.test(sql)) {
        return options.jobCounts === undefined
          ? { queued_count: 0, running_count: 0, failed_count: 0, job_count: 1 }
          : options.jobCounts;
      }
      return options.jobRow === undefined
        ? { id: "job-1", case_id: "case-1", status: "running" }
        : options.jobRow;
    }
    if (/from order_sheets/i.test(sql)) {
      return options.orderSheetRow === undefined ? { id: "os-1" } : options.orderSheetRow;
    }
    if (/from cases/i.test(sql)) return caseRow;
    return null;
  }

  function allFor(sql: string): unknown[] {
    // listCases は LIST_SQL を bind せずに all() する。
    if (/from cases c/i.test(sql)) return options.listRows ?? [LIST_ROW];
    return [];
  }

  const client = {
    prepare(sql: string) {
      const result = {
        first: async () => firstFor(sql),
        all: async () => ({ results: allFor(sql), success: true, meta: {} }),
        run: async () => {
          if (options.uniqueViolationOnUpdate && /^\s*UPDATE cases/i.test(sql)) {
            throw new Error("D1_ERROR: UNIQUE constraint failed: cases.case_no");
          }
          return { results: [], success: true, meta: {} };
        },
      };
      return {
        ...result,
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return result;
        },
      };
    },
    async batch(statements: unknown[]) {
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  };

  return { client, calls };
}

function envWith(client: unknown): Bindings {
  return { DB: client } as unknown as Bindings;
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** 案件を INSERT した文だけ取り出す。 */
function caseInsert(calls: { sql: string; params: unknown[] }[]) {
  return calls.find((call) => /INSERT INTO cases/i.test(call.sql));
}

describe("POST /api/cases", () => {
  it("空の本文 {} を受けて 201 と caseId を返す", async () => {
    const db = fakeD1();
    const res = await routes.request("/", json({}), envWith(db.client));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { caseId: string };
    expect(typeof body.caseId).toBe("string");
    expect(body.caseId.length).toBeGreaterThan(0);
  });

  it("本文がまったく無くても 400 にしない (これが 502 の原因だった)", async () => {
    const db = fakeD1();
    const res = await routes.request("/", { method: "POST" }, envWith(db.client));

    expect(res.status).toBe(201);
    expect((await res.json()) as { caseId: string }).toHaveProperty("caseId");
  });

  it("取引先が未指定なら仮取引先を用意して割り当てる", async () => {
    const db = fakeD1();
    await routes.request("/", json({}), envWith(db.client));

    // 器 (partners) と案件 (cases) の両方が積まれている。
    expect(db.calls.some((call) => /INSERT OR IGNORE INTO partners/i.test(call.sql))).toBe(true);
    expect(caseInsert(db.calls)?.params[1]).toBe("partner-unassigned");
  });

  it("製造番号が来たら spec_no に入れる", async () => {
    const db = fakeD1();
    await routes.request("/", json({ specNo: "SPC-0001" }), envWith(db.client));

    expect(caseInsert(db.calls)?.params[2]).toBe("SPC-0001");
  });

  it("取引先が引けたらその id を使い、仮取引先は作らない", async () => {
    const db = fakeD1({ partner: { id: "partner-a" } });
    await routes.request("/", json({ partner: "顧客A" }), envWith(db.client));

    expect(caseInsert(db.calls)?.params[1]).toBe("partner-a");
    expect(db.calls.some((call) => /INSERT OR IGNORE INTO partners/i.test(call.sql))).toBe(false);
  });

  it("⚠ 引けない取引先名で新しい取引先を作らない (仮取引先に落とす)", async () => {
    const db = fakeD1({ partner: null });
    await routes.request("/", json({ partner: "知らない取引先" }), envWith(db.client));

    const inserted = db.calls.filter((call) => /INSERT OR IGNORE INTO partners/i.test(call.sql));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.params[0]).toBe("partner-unassigned");
    expect(caseInsert(db.calls)?.params[1]).toBe("partner-unassigned");
  });
});

describe("PATCH /api/cases/:caseId", () => {
  function patch(body: unknown): RequestInit {
    return {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  it("読み取りで分かった製造番号を埋めて、更新後の案件を返す", async () => {
    const db = fakeD1();
    const res = await routes.request("/case-1", patch({ specNo: "SPC-0001" }), envWith(db.client));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      caseId: "case-1",
      partnerName: "顧客A",
      specNo: "SPC-0001",
    });
  });

  it("案件が無ければ 404", async () => {
    const db = fakeD1({ caseRow: null });
    const res = await routes.request("/nope", patch({ specNo: "SPC-0001" }), envWith(db.client));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it("⚠ 実在しない取引先は 400 で断る (FK が無いので参照先の無い行が黙ってできる)", async () => {
    const db = fakeD1({ partner: null });
    const res = await routes.request(
      "/case-1",
      patch({ partnerId: "no-such" }),
      envWith(db.client),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_partner" });
    expect(db.calls.some((call) => /^\s*UPDATE cases/i.test(call.sql))).toBe(false);
  });

  it("実在する取引先なら付け替える", async () => {
    const db = fakeD1({ partner: { id: "partner-a" } });
    const res = await routes.request(
      "/case-1",
      patch({ partnerId: "partner-a" }),
      envWith(db.client),
    );

    expect(res.status).toBe(200);
    const update = db.calls.find((call) => /^\s*UPDATE cases/i.test(call.sql));
    expect(update?.params[1]).toBe("partner-a");
  });

  it("案件番号がぶつかったら 500 ではなく 409", async () => {
    const db = fakeD1({ uniqueViolationOnUpdate: true });
    const res = await routes.request("/case-1", patch({ caseNo: "CS-0001" }), envWith(db.client));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "case_no_taken" });
  });

  it("本文の形が違えば 400 (POST と違い、ここは厳しくてよい)", async () => {
    const db = fakeD1();
    const res = await routes.request("/case-1", patch({ specNo: 123 }), envWith(db.client));

    expect(res.status).toBe(400);
  });
});

describe("GET /api/cases — 進み具合", () => {
  const list = async (over: Record<string, unknown> = {}) => {
    const db = fakeD1({ listRows: [{ ...LIST_ROW, ...over }] });
    const res = await routes.request("/", {}, envWith(db.client));
    expect(res.status).toBe(200);
    const [row] = (await res.json()) as { progress: string | null }[];
    return row!;
  };

  it("ai_jobs の件数から集約する — 走っていれば reading", async () => {
    expect(await list({ running_count: 1, job_count: 3 })).toMatchObject({ progress: "reading" });
  });

  /**
   * ⚠⚠ **最新 1 行では出せないのがこれ。** 読み取りが成功するたびに生成ジョブが積まれ、
   *   しかも並列に走るので、`ORDER BY queued_at DESC LIMIT 1` だと 2 通目を読んでいる
   *   最中でも「書き込んだ」と出る。集約なので出ない。
   */
  it("1 件失敗しても、残りが読み取り中なら reading のまま (ポーリングを止めない)", async () => {
    expect(await list({ running_count: 2, failed_count: 1, job_count: 3 })).toMatchObject({
      progress: "reading",
    });
  });

  it("全部終わって ORDER SHEET が立っていれば written", async () => {
    expect(await list({ job_count: 2, order_sheet_status: "ai_generated" })).toMatchObject({
      progress: "written",
    });
  });

  it("全部終わっても ORDER SHEET が無ければ written と言わない (依頼書だけ届いた案件)", async () => {
    expect(await list({ job_count: 2, order_sheet_status: null })).toMatchObject({
      progress: null,
    });
  });

  it("ジョブが 1 件も無ければ null (dev-seed の案件。SUM が NULL で返る)", async () => {
    expect(
      await list({
        queued_count: null,
        running_count: null,
        failed_count: null,
        job_count: null,
      }),
    ).toMatchObject({ progress: null });
  });

  /**
   * ⚠⚠ `ai_jobs.case_id` は nullable (列を足す前に積まれたジョブが残っている)。
   *   絞りを落とすと、案件に紐づかないジョブが**どの案件にも入らないまま COUNT に効く**
   *   …ことは無いが、GROUP BY に NULL の束ができて無駄が出る。文面で固定しておく。
   */
  it("⚠ case_id が NULL のジョブは数えない (列を足す前のジョブが残っている)", () => {
    expect(LIST_SQL).toMatch(/FROM ai_jobs\s+WHERE case_id IS NOT NULL/i);
  });

  /**
   * ★ 一覧の見出しは「取引先」ではなく**発注No**。CUSTOMER を読み取らない方針なので、
   *   取引先はいつまでも仮の行のままで、列にしても全件が同じ文字になる。
   * ⚠ **「0 件」と「まだ読めていない」を混ぜない。** 読めていなければ null のまま返し、
   *   画面が「未取得」と出す。
   */
  it("★ 発注No を返す (ORDER SHEET の customer_po_no)", async () => {
    expect(await list({ customer_po_no: "F10000000" })).toMatchObject({
      customerPoNo: "F10000000",
    });
  });

  it("⚠ まだ読めていなければ null のまま返す (0 件と混ぜない)", async () => {
    expect(await list({ customer_po_no: null })).toMatchObject({ customerPoNo: null });
  });

  /**
   * ★★ 見出しの連鎖。**Customer PO が先頭。**
   *
   * ⚠⚠ `案件番号 → 表題 → 製造番号 → 取引先` だけだと、**必ず最後まで
   *   落ちる** (取り込みの経路が前 3 つをどれも入れないため)。結果、一覧の
   *   「発注」列が**全件「取引先未確定」**になる。
   * ⚠ 取引先を見出しに混ぜない (混ぜると全件が「取引先不明 / …」と名乗る) という
   *   もとの注意はそのまま生きている。最後の予備に残してあるだけ。
   * ⚠ 1 段ずつ null にして**連鎖の順番そのもの**を固定する
   *   (`LIST_ROW` の既定は `customer_po_no: "PO-0001"` なので、先頭から外していく)。
   */
  it("★ 案件の見出しは Customer PO → 案件番号 → 表題 → 製造番号 → 取引先 の順", async () => {
    expect(await list({})).toMatchObject({ caseLabel: "PO-0001" });
    expect(await list({ customer_po_no: null })).toMatchObject({ caseLabel: "CS-0001" });
    // ⚠ fixture の `title` は null なので、表題の段だけ明示的に入れて確かめる。
    expect(
      await list({ customer_po_no: null, case_no: null, title: "テスト発注" }),
    ).toMatchObject({ caseLabel: "テスト発注" });
    expect(await list({ customer_po_no: null, case_no: null })).toMatchObject({
      caseLabel: "SPC-0001",
    });
    expect(
      await list({ customer_po_no: null, case_no: null, title: null, spec_no: null }),
    ).toMatchObject({ caseLabel: "顧客A" });
  });
});

describe("GET /api/cases/jobs/:jobId — ジョブ 1 件の状態", () => {
  const get = async (options: Parameters<typeof fakeD1>[0] = {}) => {
    const db = fakeD1(options);
    const res = await routes.request("/jobs/job-1", {}, envWith(db.client));
    return { res, body: (await res.json()) as Record<string, unknown>, calls: db.calls };
  };

  /**
   * ⚠⚠ ルーティングの確認。`/jobs/:jobId` は 2 セグメントなので 1 セグメントの
   *   `/:caseId` には食われない。**裸の `/jobs` を足すと食われる**ので足さないこと。
   */
  it("`/:caseId` に食われず、ジョブとして解決される", async () => {
    const { res, body, calls } = await get();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ jobId: "job-1", caseId: "case-1" });
    // 案件詳細 (getCase) の SQL は引かれていない。
    expect(calls.some((c) => /FROM cases c\b/i.test(c.sql) && /c\.id = \?1/i.test(c.sql))).toBe(
      false,
    );
  });

  it("ジョブの生の状態と、案件の集約の両方を返す", async () => {
    const { body } = await get({
      jobRow: { id: "job-1", case_id: "case-1", status: "succeeded" },
      jobCounts: { queued_count: 0, running_count: 1, failed_count: 0, job_count: 2 },
    });
    // ⚠ ジョブ 1 件は成功していても、案件としてはまだ読み取り中。
    expect(body).toMatchObject({ jobStatus: "succeeded", progress: "reading" });
  });

  it("ジョブが無ければ 404", async () => {
    const { res, body } = await get({ jobRow: null });
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  });

  it("case_id が NULL のジョブは集約できないので progress は null", async () => {
    const { res, body } = await get({ jobRow: { id: "job-1", case_id: null, status: "queued" } });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ caseId: null, jobStatus: "queued", progress: null });
  });

  it("ORDER SHEET が無ければ written と言わない", async () => {
    const { body } = await get({
      jobRow: { id: "job-1", case_id: "case-1", status: "succeeded" },
      jobCounts: { queued_count: 0, running_count: 0, failed_count: 0, job_count: 2 },
      orderSheetRow: null,
    });
    expect(body).toMatchObject({ progress: null });
  });
});
