import type { D1Database } from "@cloudflare/workers-types";
import { foldStale, parseProgressNodes, progressOf, stagesOf, toCount } from "../lib/progress";
import { staleBefore } from "../../../shared/ai-jobs";
import type { CaseDetail, CaseRow, JobStatusResult } from "../schema";

/**
 * 案件一覧。
 *
 * ⚠⚠ **発注書・依頼書の通数と ORDER SHEET の状態は別 feature の表にある**
 *   (purchase_orders / revision_requests / order_sheets)。ESLint が feature 間の
 *   import を禁止しているので **素の SQL で読む** (import を作らないので境界違反にはならない)。
 *   表名への結合が生まれるので、表名を変えるときはこの SQL も直す。
 * ⚠ 案件との結び付きを持つのは purchase_orders.case_id / revision_requests.case_id。
 *   po_documents には case_id が無い (原本は案件が決まる前に届く)。
 * ⚠ 進み具合が読む ai_jobs も同じく別 feature (ai-review) の表。**素の SQL で読む**。
 *   写像と集約は lib/progress.ts の 1 か所だけが持つ — SQL にも画面にも書かない。
 * ⚠ 案件を先に作らせる導線は作らない (案件番号は採番しない)。案件は帳票が届いて初めて起きる。
 */
interface ListRow {
  case_id: string;
  case_no: string | null;
  title: string | null;
  spec_no: string | null;
  partner_name: string | null;
  customer_po_no: string | null;
  po_count: number;
  rr_count: number;
  order_sheet_status: string | null;
  ship_date: string | null;
  updated_at: number;
  queued_count: number | null;
  running_count: number | null;
  failed_count: number | null;
  stale_queued_count: number | null;
  stale_running_count: number | null;
  job_count: number | null;
}

/** ⚠ `case_id IS NOT NULL` を落とさないよう、api/routes.test.ts が文面を固定している。 */
export const LIST_SQL = `
  SELECT
    c.id                        AS case_id,
    c.case_no                   AS case_no,
    c.title                     AS title,
    c.spec_no                   AS spec_no,
    p.name                      AS partner_name,
    COALESCE(po.po_count, 0)    AS po_count,
    COALESCE(rr.rr_count, 0)    AS rr_count,
    os.customer_po_no           AS customer_po_no,
    os.status                   AS order_sheet_status,
    os.ship_date                AS ship_date,
    c.updated_at                AS updated_at,
    j.queued_count              AS queued_count,
    j.running_count             AS running_count,
    j.failed_count              AS failed_count,
    j.stale_queued_count        AS stale_queued_count,
    j.stale_running_count       AS stale_running_count,
    j.job_count                 AS job_count
  FROM cases c
  LEFT JOIN partners p ON p.id = c.partner_id
  LEFT JOIN (
    SELECT case_id, COUNT(*) AS po_count
      FROM purchase_orders
     WHERE deleted_at IS NULL AND case_id IS NOT NULL
     GROUP BY case_id
  ) po ON po.case_id = c.id
  LEFT JOIN (
    SELECT case_id, COUNT(*) AS rr_count
      FROM revision_requests
     WHERE deleted_at IS NULL AND case_id IS NOT NULL
     GROUP BY case_id
  ) rr ON rr.case_id = c.id
  LEFT JOIN order_sheets os ON os.case_id = c.id AND os.deleted_at IS NULL
  LEFT JOIN (
    SELECT case_id,
           SUM(CASE WHEN status = 'queued'  THEN 1 ELSE 0 END) AS queued_count,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
           SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN status = 'queued'  AND queued_at  < ?1 THEN 1 ELSE 0 END) AS stale_queued_count,
           SUM(CASE WHEN status = 'running' AND started_at < ?1 THEN 1 ELSE 0 END) AS stale_running_count,
           COUNT(*)                                            AS job_count
      FROM ai_jobs
     WHERE case_id IS NOT NULL
     GROUP BY case_id
  ) j ON j.case_id = c.id
  WHERE c.deleted_at IS NULL
  ORDER BY c.updated_at DESC
  LIMIT 100
`;

/**
 * 案件の見出し。**お客様の発注No (Customer PO) を第一に使う。**
 *
 * ⚠⚠ **Customer PO が無いと、全件が「取引先未確定」と名乗ってしまう。**
 *   取り込みの経路 (`createCase({})`) は `case_no` / `title` / `spec_no` を**どれも入れない**ので、
 *   連鎖が最後の `partner_name` まで落ち、しかも CUSTOMER を読み取らない方針なので
 *   取引先は必ず仮の行 (`取引先未確定`) になる。**すぐ下の ⚠ が警告していた状態そのもの。**
 * ⚠ **人が実際に口にする番号は Customer PO** (お客様の発注書の右上に印字されているもの)。
 *   一覧の「発注No」列が出していたのと同じ値なので、**その列は消した** (同じ値が 2 列に並ぶため)。
 * ⚠ **取引先は混ぜない。** 混ぜると全件が「取引先不明 / …」と名乗る
 *   (ORDER SHEET の CUSTOMER は読み取っていない)。
 *   取引先が決まっている案件では、それだけで名乗れるように最後の予備に残してある。
 * ⚠ 値は `order_sheets.customer_po_no`。**ORDER SHEET が起きるまでは null**
 *   (「0 件」ではなく「まだ読めていない」)。そのときは今までどおり下の連鎖に落ちる。
 */
function labelOf(
  row: Pick<ListRow, "customer_po_no" | "case_no" | "title" | "partner_name" | "spec_no">,
): string {
  if (row.customer_po_no) return row.customer_po_no;
  if (row.case_no) return row.case_no;
  if (row.title) return row.title;
  if (row.spec_no) return row.spec_no;
  return row.partner_name ?? "(名前のない発注)";
}

export async function listCases(db: D1Database): Promise<CaseRow[]> {
  // ⚠ 取り残し (落ちた consumer が残した running / 配られなかった queued) を進行中に数えない。
  const { results } = await db.prepare(LIST_SQL).bind(staleBefore()).all<ListRow>();
  return results.map((row) => ({
    caseId: row.case_id,
    caseLabel: labelOf(row),
    partnerName: row.partner_name ?? "(取引先未設定)",
    // ⚠ 発注書の右上の発注No。**ORDER SHEET が起きるまでは null** (「0 件」ではなく「まだ読めていない」)。
    customerPoNo: row.customer_po_no,
    purchaseOrderCount: Number(row.po_count),
    revisionRequestCount: Number(row.rr_count),
    orderSheetStatus: row.order_sheet_status,
    // ⚠ order_sheets.ship_date は text (YYYY-MM-DD)。空が正常 (営業が決める欄)。
    shipDate: row.ship_date,
    updatedAt: new Date(row.updated_at).toISOString(),
    // ⚠ 「最新のジョブ」ではなく**集約**。理由は lib/progress.ts の冒頭。
    progress: progressOf(
      foldStale({
        queued: toCount(row.queued_count),
        running: toCount(row.running_count),
        failed: toCount(row.failed_count),
        staleQueued: toCount(row.stale_queued_count),
        staleRunning: toCount(row.stale_running_count),
        total: toCount(row.job_count),
        hasOrderSheet: row.order_sheet_status !== null,
      }),
    ),
  }));
}

/**
 * 案件 1 件ぶんのジョブの件数。`GET /api/cases/jobs/:jobId` が使う。
 * ⚠ `ai_jobs_case_idx (case_id, queued_at)` が効く。
 */
const JOB_COUNTS_SQL = `
  SELECT
    SUM(CASE WHEN status = 'queued'  THEN 1 ELSE 0 END) AS queued_count,
    SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
    SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN status = 'queued'  AND queued_at  < ?2 THEN 1 ELSE 0 END) AS stale_queued_count,
    SUM(CASE WHEN status = 'running' AND started_at < ?2 THEN 1 ELSE 0 END) AS stale_running_count,
    -- ★ いつから読み取り中か。**取り残しは混ぜない** (?2 以降に始まったものだけ)。
    MIN(CASE
          WHEN status = 'queued'  AND queued_at  >= ?2 THEN queued_at
          WHEN status = 'running' AND started_at >= ?2 THEN started_at
        END)                                            AS ingesting_since,
    COUNT(*)                                            AS job_count,
    -- ★★ 段を出すためのジョブ種別ごとの件数 (lib/progress.ts の stagesOf)。
    --    ⚠ progressOf() が見る上の 5 つは種別で絞らないまま。混ぜないこと。
    --    ⚠ ここはテンプレートリテラルの中。**バッククォートを書かないこと**(文字列が切れる)。
    SUM(CASE WHEN job_type = 'doc_extract' THEN 1 ELSE 0 END) AS extract_total,
    SUM(CASE WHEN job_type = 'doc_extract' AND status = 'queued'  THEN 1 ELSE 0 END) AS extract_queued,
    SUM(CASE WHEN job_type = 'doc_extract' AND status = 'running' THEN 1 ELSE 0 END) AS extract_running,
    SUM(CASE WHEN job_type = 'doc_extract' AND status = 'failed'  THEN 1 ELSE 0 END) AS extract_failed,
    SUM(CASE WHEN job_type = 'order_sheet_generate' THEN 1 ELSE 0 END) AS generate_total,
    SUM(CASE WHEN job_type = 'order_sheet_generate' AND status = 'queued'  THEN 1 ELSE 0 END) AS generate_queued,
    SUM(CASE WHEN job_type = 'order_sheet_generate' AND status = 'running' THEN 1 ELSE 0 END) AS generate_running,
    SUM(CASE WHEN job_type = 'order_sheet_generate' AND status = 'failed'  THEN 1 ELSE 0 END) AS generate_failed
  FROM ai_jobs
  WHERE case_id = ?1
`;

/**
 * ★ ジョブ 1 件の状態 (`GET /api/cases/jobs/:jobId`)。
 *
 * ⚠⚠ **一覧を 3 秒ごとに引かせない。** `GET /api/cases` は 5 つの JOIN が走る。
 *   アップロード直後に追いたいのは「そのジョブ 1 件」だけなので、ここを分けてある。
 * ⚠ 返す `progress` は**ジョブ 1 件ではなく案件の集約**。読み取りジョブ 1 件の `succeeded` は
 *   「ORDER SHEET に書き込んだ」を意味しない (そのあとに生成ジョブが別に積まれるため)。
 * ⚠ ai_jobs / order_sheets は別 feature の表。import せず生の SQL で読む (listCases と同じ)。
 */
export async function getJobStatus(
  db: D1Database,
  jobId: string,
): Promise<JobStatusResult | undefined> {
  const job = await db
    // ★ `progress_json` は**このジョブ 1 件**の内訳 (並列のノード)。段の進み具合は案件の集約。
    .prepare(`SELECT id, case_id, status, progress_json FROM ai_jobs WHERE id = ?1 LIMIT 1`)
    .bind(jobId)
    .first<{ id: string; case_id: string | null; status: string; progress_json: string | null }>();
  if (!job) return undefined;

  const nodes = parseProgressNodes(job.progress_json);

  // ⚠ case_id は nullable (列を足す前のジョブ)。集約できないので progress は null。
  if (!job.case_id) {
    return {
      jobId: job.id,
      caseId: null,
      jobStatus: job.status,
      progress: null,
      ingestingSince: null,
      stages: [],
    };
  }

  const [counts, sheet] = await Promise.all([
    db.prepare(JOB_COUNTS_SQL).bind(job.case_id, staleBefore()).first<{
      queued_count: number | null;
      running_count: number | null;
      failed_count: number | null;
      stale_queued_count: number | null;
      stale_running_count: number | null;
      ingesting_since: number | null;
      job_count: number | null;
      extract_total: number | null;
      extract_queued: number | null;
      extract_running: number | null;
      extract_failed: number | null;
      generate_total: number | null;
      generate_queued: number | null;
      generate_running: number | null;
      generate_failed: number | null;
    }>(),
    db
      .prepare(`SELECT id FROM order_sheets WHERE case_id = ?1 AND deleted_at IS NULL LIMIT 1`)
      .bind(job.case_id)
      .first<{ id: string }>(),
  ]);

  const since = counts?.ingesting_since;
  const hasOrderSheet = Boolean(sheet);
  return {
    jobId: job.id,
    caseId: job.case_id,
    jobStatus: job.status,
    // ⚠ ai_jobs の時刻は timestamp_ms の integer。画面へは ISO で渡す。
    ingestingSince: typeof since === "number" ? new Date(since).toISOString() : null,
    progress: progressOf(
      foldStale({
        queued: toCount(counts?.queued_count),
        running: toCount(counts?.running_count),
        failed: toCount(counts?.failed_count),
        staleQueued: toCount(counts?.stale_queued_count),
        staleRunning: toCount(counts?.stale_running_count),
        total: toCount(counts?.job_count),
        hasOrderSheet,
      }),
    ),
    /*
     * ★★ 段。**`progress` を置き換えるのではなく並べる** (あちらはポーリングの継続判定)。
     * ⚠ 内訳 (`nodes`) は**このジョブ 1 件**のもの。PDF が複数なら読み取りジョブも
     *   複数あるが、画面が追っているのは 1 件なので、その 1 件の並列だけを出す。
     */
    stages: stagesOf({
      nodes,
      byType: {
        extract: {
          queued: toCount(counts?.extract_queued),
          running: toCount(counts?.extract_running),
          failed: toCount(counts?.extract_failed),
          total: toCount(counts?.extract_total),
        },
        generate: {
          queued: toCount(counts?.generate_queued),
          running: toCount(counts?.generate_running),
          failed: toCount(counts?.generate_failed),
          total: toCount(counts?.generate_total),
        },
      },
      hasOrderSheet,
    }),
  };
}

/**
 * ★ その案件で**いま走っている**読み取りジョブ。無ければ null。
 *
 * ⚠⚠ **画面を離れても読み取りは止まらない** (走っているのはキューの consumer であって
 *   ブラウザではない)。戻ってきたときに「読み取り中」と分かるように、
 *   **画面が追うべきジョブの id をここで返す**。これが無いと、
 *   アップロード / やり直しの直後だけスピナーが出て、再読み込みすると消える。
 * ⚠ 取り残し (`JOB_STALE_MS` 超え) は返さない。永遠に回るスピナーを作らないため。
 * ⚠ 新しいものを返す (読み取りの後に生成ジョブが積まれるので、いま追うべきは最後のもの)。
 */
const INGESTING_JOB_SQL = `
  SELECT id
    FROM ai_jobs
   WHERE case_id = ?1
     AND ( (status = 'queued'  AND queued_at  >= ?2)
        OR (status = 'running' AND started_at >= ?2) )
   ORDER BY queued_at DESC
   LIMIT 1
`;

export async function getCase(db: D1Database, caseId: string): Promise<CaseDetail | undefined> {
  const row = await db
    .prepare(
      /*
       * ⚠⚠ **`order_sheets` を JOIN するのは `labelOf()` のため。**
       *   一覧と詳細は同じ `labelOf()` を使うので、ここで `customer_po_no` を引かないと
       *   **同じ案件が 2 つの画面で違う名前を名乗る**。
       * ⚠ 1 案件に ORDER SHEET は 1 つ (`deleted_at IS NULL` のもの)。一覧の SQL と同じ条件。
       */
      `SELECT c.id AS case_id, c.case_no, c.title, c.spec_no, c.status, c.updated_at,
              p.name AS partner_name, os.customer_po_no AS customer_po_no
         FROM cases c
         LEFT JOIN partners p ON p.id = c.partner_id
         LEFT JOIN order_sheets os ON os.case_id = c.id AND os.deleted_at IS NULL
        WHERE c.id = ?1 AND c.deleted_at IS NULL
        LIMIT 1`,
    )
    .bind(caseId)
    .first<{
      case_id: string;
      case_no: string | null;
      title: string | null;
      spec_no: string | null;
      status: string;
      updated_at: number;
      partner_name: string | null;
      customer_po_no: string | null;
    }>();
  if (!row) return undefined;

  const ingesting = await db
    .prepare(INGESTING_JOB_SQL)
    .bind(caseId, staleBefore())
    .first<{ id: string }>();

  return {
    caseId: row.case_id,
    caseLabel: labelOf(row),
    partnerName: row.partner_name ?? "(取引先未設定)",
    specNo: row.spec_no,
    status: row.status,
    updatedAt: new Date(row.updated_at).toISOString(),
    ingestingJobId: ingesting?.id ?? null,
  };
}

/**
 * ⚠⚠ **取引先が読めるのは読み取りの後**（発注書に印字されている）。それなのに
 *   `cases.partner_id` は NOT NULL なので、取引先が決まる前の案件を置く器が要る。
 * ⚠ `partners` はこの feature の持ち物ではないので import せず、生の SQL で足す
 *   （seed.ts と同じ idiom）。
 * ⚠ 固有名詞を書かない。
 */
const UNASSIGNED_PARTNER = {
  id: "partner-unassigned",
  code: "PT-UNASSIGNED",
  name: "取引先未確定",
  shortName: "未確定",
} as const;

/**
 * `cases.case_no` は UNIQUE。ぶつかったときに `createApp()` の onError が一律
 * `500 internal_error` にしてしまうので、ルートが 409 に振り分けられるよう包み直す。
 */
export class CaseNoTaken extends Error {}

/** D1 が返す UNIQUE 違反かどうか。SQLite の文言でしか判別できない。 */
function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(
    error instanceof Error ? `${error.message} ${error.cause ?? ""}` : String(error),
  );
}

/** 取引先を名前・コード・略称のいずれかで引く。見つからなければ undefined。 */
async function findPartnerId(db: D1Database, partner?: string): Promise<string | undefined> {
  const needle = partner?.trim();
  if (!needle) return undefined;
  const row = await db
    .prepare(
      `SELECT id FROM partners
        WHERE deleted_at IS NULL AND (code = ?1 OR name = ?1 OR short_name = ?1)
        LIMIT 1`,
    )
    .bind(needle)
    .first<{ id: string }>();
  return row?.id;
}

/** 取引先が実在するか。FK が無いので、PATCH の前にルートがこれで確かめる。 */
export async function partnerExists(db: D1Database, partnerId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM partners WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`)
    .bind(partnerId)
    .first<{ id: string }>();
  return row !== null && row !== undefined;
}

/**
 * ★ 案件を起こす（`POST /api/cases`）。**取り込みパイプラインから呼ばれる。**
 *
 * ⚠ **空の入力で必ず成功すること。** 取り込み側はアップロードの時点で `{}` のまま呼ぶ。
 * ⚠ 取引先が引けなくても**新しい取引先を作らない**。検証されていない文字列からマスタを
 *   生やすと、あとで名寄せできなくなる。仮取引先に落として、読み取り後に
 *   `PATCH /api/cases/:caseId` で正しい取引先に付け替える。
 * ⚠ `case_no` は NULL のまま。SQLite の UNIQUE index は NULL を重複と見ないので、
 *   番号の無い案件はいくつでも作れる（案件番号は採番せず、人にも決めさせない）。
 */
export async function createCase(
  db: D1Database,
  input: { partner?: string; specNo?: string },
): Promise<string> {
  const now = Date.now();
  const caseId = crypto.randomUUID();
  const partnerId = (await findPartnerId(db, input.partner)) ?? UNASSIGNED_PARTNER.id;

  const statements = [];
  // 仮取引先に落ちるときだけ器を用意する（実在の取引先が引けたなら触らない）。
  if (partnerId === UNASSIGNED_PARTNER.id) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO partners (id, code, name, short_name, country, tax_mode,
             po_no_label, is_active, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'JP', 'excluded', 'customer_po', 1, ?5, ?5)`,
        )
        .bind(
          UNASSIGNED_PARTNER.id,
          UNASSIGNED_PARTNER.code,
          UNASSIGNED_PARTNER.name,
          UNASSIGNED_PARTNER.shortName,
          now,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO cases (id, partner_id, spec_no, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'open', ?4, ?4)`,
      )
      .bind(caseId, partnerId, input.specNo?.trim() || null, now),
  );

  // ⚠ D1 の batch は 1 往復で、かつトランザクション。取引先だけ入って案件が入らない、を防ぐ。
  await db.batch(statements);
  return caseId;
}

/**
 * 読み取りが終わってから案件を埋める（`PATCH /api/cases/:caseId`）。
 *
 * ⚠ **欄を NULL に戻せない**（COALESCE で埋めるため）。この口は「読み取って分かったものを
 *   埋める」ためのものなので、それでよい。消す操作が要るようになったら形を変えること。
 * ⚠ 動的な SET 句を組まないのは、組み立てた SQL が bind の番号とずれる事故を無くすため。
 * ⚠ 取引先は feature をまたぐソフト参照で FK が無い。**実在を確かめるのは呼ぶ側の責任**
 *   （ルートが 400 unknown_partner を返す）。ここで確かめると PATCH のたびに 1 往復増える。
 */
export async function updateCase(
  db: D1Database,
  caseId: string,
  patch: { partnerId?: string; specNo?: string; caseNo?: string; title?: string },
): Promise<CaseDetail | undefined> {
  try {
    await db
      .prepare(
        `UPDATE cases
            SET partner_id = COALESCE(?2, partner_id),
                spec_no    = COALESCE(?3, spec_no),
                case_no    = COALESCE(?4, case_no),
                title      = COALESCE(?5, title),
                updated_at = ?6
          WHERE id = ?1 AND deleted_at IS NULL`,
      )
      .bind(
        caseId,
        patch.partnerId ?? null,
        patch.specNo ?? null,
        patch.caseNo ?? null,
        patch.title ?? null,
        Date.now(),
      )
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new CaseNoTaken(`発注番号が既に使われています。`);
    throw error;
  }

  // ⚠ 行が無ければ getCase が undefined を返す ＝ 404 の判定が既存の 1 か所で済む。
  return getCase(db, caseId);
}
