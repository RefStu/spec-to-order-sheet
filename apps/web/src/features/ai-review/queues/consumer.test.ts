import type { MessageBatch } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../../shared/hono";

// ⚠ ai 側は呼ばない。ここで確かめたいのは consumer の判断だけ:
//   **形が違うメッセージを捨てるか (ack)、失敗を投げ返すか (retry)。**
//   ここを間違えると「デプロイは成功したまま全メッセージが DLQ に落ちる」壊れ方をする。
vi.mock("../../../shared/ai/ai-client", () => ({ fetchAi: vi.fn(), relayStream: vi.fn() }));

const { fetchAi } = await import("../../../shared/ai/ai-client");
const { consumer } = await import("./consumer");

/**
 * ai_jobs の列の並び (drizzle が select() に出す順 = schema.ts の宣言順)。
 *
 * ⚠ **列を足したらここも同じ位置に足すこと。** drizzle は `.raw()` の**値の配列**を
 *   位置で読むので、ずれても落ちずに**隣の列の値が入る**。気付けない壊れ方をする。
 */
const AI_JOB_COLUMNS = [
  "id",
  "job_type",
  "status",
  "target_kind",
  "target_id",
  "case_id",
  "input_file_id",
  "prompt_id",
  "model_name",
  "attempt",
  "input_tokens",
  "output_tokens",
  "cost_micro",
  "latency_ms",
  "trace_id",
  "error_message",
  "queued_at",
  "started_at",
  "finished_at",
] as const;

const aiJobRow: Record<string, unknown> = {
  id: "job-1",
  job_type: "doc_extract",
  status: "queued",
  target_kind: "po_document",
  target_id: "doc-1",
  case_id: "case-1",
  input_file_id: "file-1",
  prompt_id: null,
  model_name: null,
  attempt: 1,
  input_tokens: null,
  output_tokens: null,
  cost_micro: null,
  latency_ms: null,
  trace_id: "0123456789abcdef0123456789abcdef",
  error_message: null,
  queued_at: 1_700_000_000_000,
  started_at: null,
  finished_at: null,
};

/** loadDocument の select が並べる 4 列。 */
const documentRow = ["doc-1", "documents/inbound/file-1.pdf", "sample.pdf", "application/pdf"];

/**
 * D1 の代わり。**SQL は実行せず**、どの表を引いたかだけ見て決まった行を返す。
 *
 * ⚠ drizzle は列を指定した select で `.raw()` を使い、**値の配列**を期待する。
 */
function fakeD1(options: { job?: Record<string, unknown> | null } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const job = options.job === undefined ? aiJobRow : options.job;

  /**
   * ⚠ `recordJobProgress` は**読んで畳んで書き戻す**ので、書いた値を覚えて返す。
   *   返さないと、この偽の D1 では畳みが起きず「最後の 1 件だけ」に見えてしまう。
   */
  let progressJson: string | null = null;

  function rowsFor(sql: string): unknown[][] {
    // ⚠ 進捗の select は 1 列だけ。全列の行を返すと drizzle が別の列として読む。
    if (/select "progress_json" from "ai_jobs"/i.test(sql)) return [[progressJson]];
    if (/from "ai_jobs"/i.test(sql)) return job ? [AI_JOB_COLUMNS.map((c) => job[c])] : [];
    if (/from "po_documents"/i.test(sql) && /inner join "files"/i.test(sql)) return [documentRow];
    return [];
  }

  /** ⚠ batch に渡された文もここに積む。**順番**を見たいので分けて覚える。 */
  const batches: { sql: string; params: unknown[] }[][] = [];

  const client = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = { sql, params };
          calls.push(statement);
          if (/update "ai_jobs" set/i.test(sql) && /"progress_json"/i.test(sql)) {
            const written = params.find(
              (value): value is string => typeof value === "string" && value.includes("nodes"),
            );
            progressJson = written ?? null;
          }
          const rows = rowsFor(sql);
          return {
            raw: async () => rows,
            all: async () => ({ results: rows, success: true, meta: {} }),
            run: async () => ({ results: [], success: true, meta: {} }),
            // drizzle の batch は bind 済みの文をそのまま並べる。印を付けて追えるようにする。
            __statement: statement,
          };
        },
      };
    },
    /**
     * ⚠⚠ **D1 の batch は 1 往復のトランザクション。**
     *   「前の版を取り下げる → 書く」が割れないことを、ここで見る。
     */
    async batch(statements: { __statement?: { sql: string; params: unknown[] } }[]) {
      batches.push(statements.map((s) => s.__statement ?? { sql: "?", params: [] }));
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  };
  return { client, calls, batches };
}

function envWith(client: unknown, bucket?: unknown): Bindings {
  return {
    DB: client,
    FILES_BUCKET: bucket ?? { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
    // 読み取りの成功後に order_sheet_generate を積む。
    JOBS_QUEUE: { send: async () => {} },
    // 案件の書き戻しは service binding (RPC)。HTTP ではないのでトークンが要らない。
    CASES: { updateCase: async () => true },
  } as unknown as Bindings;
}

function batchOf(body: unknown) {
  const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  return {
    batch: {
      queue: "spec-to-order-sheet-jobs",
      messages: [message],
    } as unknown as MessageBatch<unknown>,
    message,
  };
}

const run = (b: MessageBatch<unknown>, env: Bindings) => consumer.handle(b, env, {} as never);

/**
 * ai が返す **NDJSON** (1 行 1 JSON)。**最後の 1 行が結果。**
 *
 * ⚠⚠ **`Response.json()` に戻さない。** consumer は読みながら進捗を D1 に書く形に
 *   変わっている。1 回の JSON 応答の経路は ai 側に残してあるが、
 *   consumer はもう使わない。
 */
function ndjson(...lines: unknown[]): Response {
  const body = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

/** 読み取りの結果 1 本だけを流す (進捗を見ないテスト用)。 */
const resultOnly = (result: unknown) => ndjson({ type: "result", result });

beforeEach(() => vi.mocked(fetchAi).mockReset());

describe("ai-review の consumer", () => {
  it("wrangler.jsonc と同じキュー名を名乗る", () => {
    // ⚠ ずれるとデプロイは成功したまま全メッセージが DLQ に落ちる。
    expect(consumer.queue).toBe("spec-to-order-sheet-jobs");
  });

  it("形が違うメッセージは捨てる (再試行しても直らない)", async () => {
    const { batch, message } = batchOf({ jobId: "job-1" }); // caseId が無い
    await run(batch, envWith(fakeD1().client));

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(fetchAi).not.toHaveBeenCalled();
  });

  it("ai_jobs に無いジョブも捨てる", async () => {
    const { batch, message } = batchOf({ jobId: "job-x", caseId: "case-1" });
    await run(batch, envWith(fakeD1({ job: null }).client));

    expect(message.ack).toHaveBeenCalled();
    expect(fetchAi).not.toHaveBeenCalled();
  });

  it("ai が失敗を返したら投げ返し、ジョブを failed にする", async () => {
    vi.mocked(fetchAi).mockResolvedValue(
      new Response("boom", { status: 500 }) as unknown as Response,
    );
    const db = fakeD1();
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWith(db.client));

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    const updates = db.calls.filter((c) => /^update/i.test(c.sql.trim()));
    expect(updates.some((c) => c.params.includes("failed"))).toBe(true);
  });

  it("⚠ 決めた形から外れた応答も投げ返す (黙って空の結果を書かない)", async () => {
    // ⚠ 形が違う行は**捨てる**ので、結果の行が 1 つも無いまま終わる → 失敗。
    vi.mocked(fetchAi).mockResolvedValue(
      resultOnly({ extraction: { header: {} } }) as unknown as Response,
    );
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWith(fakeD1().client));

    expect(message.retry).toHaveBeenCalled();
  });

  /**
   * ⚠⚠ **途中で切れた stream を成功にしない。** 成功で畳むと、読めていない帳票が
   *   `succeeded` になって**人が気づけない**。
   */
  it("⚠⚠ 結果の行が来ないまま切れたら投げ返す", async () => {
    vi.mocked(fetchAi).mockResolvedValue(
      ndjson({
        type: "progress",
        node: "classify",
        label: "発注書フォーマットを分類",
        stage: "classify",
        status: "running",
        at: 1,
      }) as unknown as Response,
    );
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWith(fakeD1().client));

    expect(message.retry).toHaveBeenCalled();
  });

  /**
   * ★★ **進捗は読みながら D1 に書く。** 画面はこれをポーリングで読む
   *   (`ai_jobs.progress_json` → `cases/services/case-service.ts`)。
   * ⚠⚠ **ノードは `node` を鍵に畳む。** 表示用の語 (`label`) で畳むと、
   *   語を変えた瞬間に同じノードが 2 つに増える。
   * ⚠ 並列に走るノードは**同時に running のまま**残る。それが「並列だと分かる」形。
   */
  it("★★ 進捗を読みながら ai_jobs.progress_json に書く", async () => {
    vi.mocked(fetchAi).mockResolvedValue(
      ndjson(
        {
          type: "progress",
          node: "po",
          label: "発注書",
          stage: "extract",
          status: "running",
          at: 1,
        },
        {
          type: "progress",
          node: "spec-1",
          label: "依頼書 1 枚目",
          stage: "extract",
          status: "running",
          at: 2,
        },
        {
          type: "progress",
          node: "po",
          label: "発注書",
          stage: "extract",
          status: "succeeded",
          at: 3,
        },
        { type: "result", result: PO_RESPONSE },
      ) as unknown as Response,
    );
    const db = fakeD1();
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWith(db.client));

    expect(message.ack).toHaveBeenCalled();
    const written = db.calls
      .filter((c) => /update "ai_jobs" set/i.test(c.sql) && /"progress_json"/i.test(c.sql))
      .flatMap((c) => c.params)
      .filter((v): v is string => typeof v === "string" && v.includes("nodes"));
    expect(written.length).toBeGreaterThan(0);

    const last = JSON.parse(written[written.length - 1]!) as {
      nodes: Record<string, { label: string; status: string }>;
    };
    // ⚠ 同じノードの running → succeeded は 1 件に畳む (行を増やさない)。
    expect(last.nodes.po).toMatchObject({ label: "発注書", status: "succeeded" });
    // ⚠ 並列のもう 1 本は走ったまま残る。
    expect(last.nodes["spec-1"]).toMatchObject({ label: "依頼書 1 枚目", status: "running" });
  });

  it("⚠ ai が error の行を返したら投げ返す", async () => {
    vi.mocked(fetchAi).mockResolvedValue(
      ndjson({ type: "error", error: "pdftoppm が見つかりません" }) as unknown as Response,
    );
    const db = fakeD1();
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWith(db.client));

    expect(message.retry).toHaveBeenCalled();
    const updates = db.calls.filter((c) => /^update/i.test(c.sql.trim()));
    expect(updates.some((c) => c.params.some((v) => String(v).includes("pdftoppm")))).toBe(true);
  });

  it("R2 に原本が無ければ投げ返す", async () => {
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWith(fakeD1().client, { get: async () => null }));

    expect(message.retry).toHaveBeenCalled();
    expect(fetchAi).not.toHaveBeenCalled();
  });
});

const EMPTY_FIELD = { value: null, quote: null, page: null, confidence: 0 };

/** 依頼書 1 枚ぶん (最小限)。 */
const SPEC_SHEET = {
  specNo: { value: "2099-12-S002", quote: "2099 - 12 - S002", page: 2, confidence: 90 },
  productName: EMPTY_FIELD,
  purityText: EMPTY_FIELD,
  requestCategoryText: EMPTY_FIELD,
  // ⚠ 枠は**複数**返る形。`links` は `.default([])` なので書かない。
  pictures: [],
};

/** 分類のページ 1 枚ぶん (テスト用の最小の形)。 */
function page(no: number, docType: "purchase_order" | "spec_sheet" | "other") {
  return { page: no, docType, headerQuote: null, startsNewSheet: true, confidence: 90 };
}

/**
 * ai が返す、形の通った読み取り結果 (最小限)。
 * ⚠ **発注書 1 通 + 依頼書 n 枚が 1 つの応答で返る** (内包 PDF)。
 */
const PO_RESPONSE = {
  model: "test",
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 1,
  rawOutput: "{}",
  extraction: {
    formCode: null,
    purchaseOrder: {
      header: {
        customerPoNo: { value: "PO-0001", quote: "PO-0001", page: 1, confidence: 90 },
      },
      lines: [],
    },
    specSheets: [],
    pictures: [],
  },
  classification: {
    formCode: null,
    formName: null,
    formConfidence: 90,
    // ⚠ ページ 1 枚ずつの種類。**parts は ai 側でコードが組み立てたもの。**
    pages: [page(1, "purchase_order")],
    parts: [{ role: "purchase_order", pages: [1], confidence: 90 }],
  },
};

/** 内包 PDF (発注書 1 通 + 依頼書 2 枚)。 */
const MIXED_RESPONSE = {
  ...PO_RESPONSE,
  extraction: { ...PO_RESPONSE.extraction, specSheets: [SPEC_SHEET, SPEC_SHEET] },
  classification: {
    formCode: null,
    formName: null,
    formConfidence: 90,
    // ⚠ ページ 1 枚ずつの種類。**parts は ai 側でコードが組み立てたもの。**
    pages: [page(1, "purchase_order"), page(2, "spec_sheet"), page(3, "spec_sheet")],
    parts: [
      { role: "purchase_order", pages: [1], confidence: 90 },
      { role: "spec_sheet", pages: [2], confidence: 90 },
      { role: "spec_sheet", pages: [3], confidence: 90 },
    ],
  },
};

/** 依頼書だけの PDF。 */
const SPEC_ONLY_RESPONSE = {
  ...PO_RESPONSE,
  extraction: {
    formCode: null,
    purchaseOrder: null,
    specSheets: [SPEC_SHEET],
    pictures: [],
  },
  classification: {
    formCode: null,
    formName: null,
    formConfidence: 90,
    // ⚠ ページ 1 枚ずつの種類。**parts は ai 側でコードが組み立てたもの。**
    pages: [page(1, "spec_sheet")],
    parts: [{ role: "spec_sheet", pages: [1], confidence: 90 }],
  },
};

describe("読み取りのあとに案件を埋める (service binding の RPC)", () => {
  const envWithCases = (cases: unknown) =>
    ({
      DB: fakeD1().client,
      FILES_BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
      JOBS_QUEUE: { send: async () => {} },
      CASES: cases,
    }) as unknown as Bindings;

  it("読み取れた取引先を案件に返す", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(PO_RESPONSE) as unknown as Response);
    const seen: unknown[] = [];
    const { batch } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(
      batch,
      envWithCases({
        updateCase: async (caseId: string, patch: unknown) => {
          seen.push({ caseId, patch });
          return true;
        },
      }),
    );

    // ⚠ 埋めないと案件一覧が「取引先未確定」のままになる。
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ caseId: "case-1" });
  });

  it("⚠ 案件の更新に失敗しても読み取りは成功扱い (retry すると帳票が二重に入る)", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(PO_RESPONSE) as unknown as Response);
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(
      batch,
      envWithCases({
        updateCase: async () => {
          throw new Error("cases down");
        },
      }),
    );

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("案件が見つからない (false) でも読み取りは成功扱い", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(PO_RESPONSE) as unknown as Response);
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWithCases({ updateCase: async () => false }));

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe("ORDER SHEET の生成を積む", () => {
  it("読み取りが成功したら order_sheet_generate を積む", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(PO_RESPONSE) as unknown as Response);
    const sent: unknown[] = [];
    const db = fakeD1();
    const { batch } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, {
      DB: db.client,
      FILES_BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
      JOBS_QUEUE: { send: async (m: unknown) => void sent.push(m) },
      CASES: { updateCase: async () => true },
    } as unknown as Bindings);

    expect(sent).toHaveLength(1);
    expect(db.calls.some((c) => c.params.includes("order_sheet_generate"))).toBe(true);
  });

  it("⚠ 積めなくても読み取りは成功扱い (retry すると帳票が二重に入る)", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(PO_RESPONSE) as unknown as Response);
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, {
      DB: fakeD1().client,
      FILES_BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
      JOBS_QUEUE: {
        send: async () => {
          throw new Error("queue down");
        },
      },
      CASES: { updateCase: async () => true },
    } as unknown as Bindings);

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe("★ 内包 PDF — 1 通で発注書と依頼書の両方を書く", () => {
  const envOf = (db: { client: unknown }) =>
    ({
      DB: db.client,
      FILES_BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
      JOBS_QUEUE: { send: async () => {} },
      CASES: { updateCase: async () => true },
    }) as unknown as Bindings;

  it("発注書 1 通 + 依頼書 2 枚を 1 回の読み取りで書く", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(MIXED_RESPONSE) as unknown as Response);
    const db = fakeD1();
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envOf(db));

    expect(message.ack).toHaveBeenCalled();
    const written = db.batches.at(-1) ?? [];
    expect(written.filter((s) => /insert into "purchase_orders"/i.test(s.sql))).toHaveLength(1);
    // ⚠ 依頼書は**枚数ぶん**行ができる。1 枚に畳まれていたらここで落ちる。
    expect(written.filter((s) => /insert into "revision_requests"/i.test(s.sql))).toHaveLength(2);
  });

  it("⚠⚠ 前の版の取り下げが batch の先頭 2 文", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(MIXED_RESPONSE) as unknown as Response);
    const db = fakeD1();
    const { batch } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envOf(db));

    const written = db.batches.at(-1) ?? [];
    // 取り下げ → 書き込み の順でないと、同じ鍵の行が 2 つ生きる瞬間ができる。
    expect(written[0]?.sql).toMatch(/update "purchase_orders" set .*"deleted_at"/i);
    expect(written[1]?.sql).toMatch(/update "revision_requests" set .*"deleted_at"/i);
    // 原本の更新は最後 (読めた結果で doc_kind が決まる)。
    expect(written.at(-1)?.sql).toMatch(/update "po_documents"/i);
  });

  it("読めた中身で doc_kind が決まる (mixed)", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(MIXED_RESPONSE) as unknown as Response);
    const db = fakeD1();
    const { batch } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envOf(db));

    expect(db.batches.at(-1)?.at(-1)?.params).toContain("mixed");
  });

  it("依頼書だけの PDF も同じ経路で通る (発注書は書かない)", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(SPEC_ONLY_RESPONSE) as unknown as Response);
    const db = fakeD1();
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envOf(db));

    expect(message.ack).toHaveBeenCalled();
    const written = db.batches.at(-1) ?? [];
    expect(written.some((s) => /insert into "purchase_orders"/i.test(s.sql))).toBe(false);
    expect(written.filter((s) => /insert into "revision_requests"/i.test(s.sql))).toHaveLength(1);
    expect(written.at(-1)?.params).toContain("spec_sheet");
  });

  it("★ トレース ID を ai に渡す (1 アップロード = 1 トレース)", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(PO_RESPONSE) as unknown as Response);
    const { batch } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envOf(fakeD1()));

    const sent = vi.mocked(fetchAi).mock.calls[0]?.[1] as {
      path: string;
      body: Record<string, unknown>;
    };
    // ⚠ 進捗つきの NDJSON のほう (1 回の JSON 応答のルートは ai 側に残してある)。
    expect(sent.path).toBe("/v1/doc-extract/document/stream");
    expect(sent.body.tracingOptions).toMatchObject({
      traceId: "0123456789abcdef0123456789abcdef",
      metadata: { sessionId: "case-1" },
    });
    /*
     * ⚠⚠ **指示文も様式の候補も渡さない**。正は ai の `prompts/` のファイル (git)。
     *   ここに渡す形へ戻すときは、`ai_jobs.prompt_id` が `ai_prompts.id` への**外部キー**である
     *   ことに注意 (符号のような文字列を入れると insert ごと落ちる)。
     */
    expect(sent.body).not.toHaveProperty("formProfiles");
    expect(sent.body).not.toHaveProperty("prompts");
  });

  it("⚠ 積まれたままの古いジョブ (po_extract) も同じ経路で通る", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(PO_RESPONSE) as unknown as Response);
    const db = fakeD1({ job: { ...aiJobRow, job_type: "po_extract" } });
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envOf(db));

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

/**
 * ★ 切り出せた代表の図を R2 に預けるところ。
 *
 * ⚠⚠ **`pictureIndex` を渡さないと全部同じ鍵になり、最後の 1 枚だけが残る。**
 *   鍵の式は `files/services/upload-service.ts` の `photoStorageKey()` だけが持つ
 *   (1 枚目は接尾辞なし / 2 枚目以降は `_n`)。
 */
describe("★ 代表の図を R2 に預ける", () => {
  const BOX = {
    page: 1,
    x: 0.1,
    y: 0.6,
    width: 0.1,
    height: 0.06,
    confidence: 60,
    labelQuote: "完成イメージ",
  };

  /** 依頼書 1 枚に代表の図が 2 枚付いた応答。 */
  const TWO_PICTURES = {
    ...SPEC_ONLY_RESPONSE,
    extraction: {
      ...SPEC_ONLY_RESPONSE.extraction,
      pictures: [
        {
          specSheetIndex: 0,
          pictureIndex: 0,
          dataBase64: "AAA=",
          mediaType: "image/jpeg",
          box: BOX,
        },
        {
          specSheetIndex: 0,
          pictureIndex: 1,
          dataBase64: "AAB=",
          mediaType: "image/jpeg",
          box: { ...BOX, x: 0.4 },
        },
      ],
    },
  };

  /** ⚠ 既定の env は `get` しか持たない。`put` を足さないと storePhoto が投げて catch に飲まれる。 */
  function envWithBucketPut(db: { client: unknown }, putKeys: string[]): Bindings {
    return {
      DB: db.client,
      FILES_BUCKET: {
        get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
        put: async (key: string) => {
          putKeys.push(key);
        },
      },
      JOBS_QUEUE: { send: async () => {} },
      CASES: { updateCase: async () => true },
    } as unknown as Bindings;
  }

  it("⚠⚠ 同じ依頼書の 2 枚が別々の鍵に入る (1 枚目は接尾辞なし)", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(TWO_PICTURES) as unknown as Response);
    const putKeys: string[] = [];
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, envWithBucketPut(fakeD1(), putKeys));

    expect(message.ack).toHaveBeenCalled();
    // 2 枚とも預かれている (同じ鍵に上書きされて 1 枚に減っていない)。
    expect(putKeys).toHaveLength(2);
    expect(new Set(putKeys).size).toBe(2);
    expect(putKeys[0]).toMatch(/^photos\/spec\/[^/]+\.jpg$/);
    expect(putKeys[1]).toMatch(/^photos\/spec\/[^/]+_1\.jpg$/);
    // 同じ依頼書のものなので接頭辞は同じ (generator は like(接頭辞) で引く)。
    expect(putKeys[1]).toBe(putKeys[0]!.replace(/\.jpg$/, "_1.jpg"));
  });

  it("⚠ 写真が預けられなくても読み取りは成功のまま (欄が空になるだけ)", async () => {
    vi.mocked(fetchAi).mockResolvedValue(resultOnly(TWO_PICTURES) as unknown as Response);
    const env = {
      DB: fakeD1().client,
      FILES_BUCKET: {
        get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
        put: async () => {
          throw new Error("R2 down");
        },
      },
      JOBS_QUEUE: { send: async () => {} },
      CASES: { updateCase: async () => true },
    } as unknown as Bindings;
    const { batch, message } = batchOf({ jobId: "job-1", caseId: "case-1" });
    await run(batch, env);

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
