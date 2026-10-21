import type { CaseProgress } from "../schema";

/**
 * ★ 取り込みの進み具合。**案件にぶら下がる ai_jobs を集約して 1 語にする。**
 *
 * ⚠⚠ **「最新のジョブ」を取ると嘘をつく。** 1 案件には 2 種類のジョブが**並列に**ぶら下がる。
 *   - アップロードは PDF 1 枚 = 1 POST なので、読み取りジョブが帳票の通数だけ積まれる
 *   - 読み取りが 1 件成功するたび、consumer が `order_sheet_generate` を**別に積む**
 *     (ai-review/queues/consumer.ts)。なので**常に生成ジョブのほうが queued_at が新しい**
 *   - wrangler.jsonc のキューは max_concurrency を指定していないので**同時に配られる**
 *   - `runOrderSheetGenerate` は発注書が 1 通も読めていなくても `succeeded` で畳む
 *   → `ORDER BY queued_at DESC LIMIT 1` だと、2 通目を読んでいる最中でも、何も生成できて
 *     いなくても「書き込んだ」と出る。**「3 通のうち 1 通がまだ読み取り中」は最新 1 行では
 *     表現できない。**
 *
 * ⚠⚠ **進行中を失敗より優先する。** 理由が 2 つある。
 *   1. hooks/use-cases.ts のポーリングは `accepted` / `reading` の行が無くなると止まる。
 *      `failed` を先に出すと、**まだ読み取り中の 2 通目・3 通目が終わっても行が更新されない**。
 *   2. `generateOrderSheet()` は冪等な upsert だが D1 のトランザクションで囲われておらず、
 *      `order_sheets.case_id` は UNIQUE。同じ案件の生成ジョブが 2 件同時に「まだ無い」を見ると
 *      片方が UNIQUE 違反で落ちて retry される。つまり**一過性の `failed` が正常系に実在する**。
 *      失敗優先だと、それで行が「失敗した」に固まり、自動では戻らない。
 *
 * ⚠ 語彙の正は `../schema.ts` の `progressSchema`。日本語は `./format.ts`。
 * ⚠ **ジョブ種別で絞らない。** `order_sheet_generate` まで数えて初めて `written`
 *   (= ORDER SHEET に書き込んだ) が意味を持つ。
 */
export interface JobCounts {
  queued: number;
  running: number;
  failed: number;
  /** case_id が付いているジョブの総数。 */
  total: number;
  /**
   * ⚠ その案件に ORDER SHEET が実在するか。
   *   これが無いと「依頼書だけ届いた案件」で `written` と出てしまう
   *   (生成ジョブは発注書 0 通でも succeeded で畳むため)。
   */
  hasOrderSheet: boolean;
}

/**
 * SQL が数えたままの件数。**取り残しを畳む前**の形。
 *
 * ⚠ `staleQueued` / `staleRunning` は `queued` / `running` の**内数**
 *   (SQL は `status = 'running' AND started_at < ?` を別に数えるだけ)。
 */
export interface RawJobCounts extends JobCounts {
  /** `queued` のうち、投入から `JOB_STALE_MS` 以上たったもの。 */
  staleQueued: number;
  /** `running` のうち、開始から `JOB_STALE_MS` 以上たったもの。 */
  staleRunning: number;
}

/**
 * 取り残された進行中を**進行中から外して失敗に数える**。
 *
 * ⚠⚠ **`progressOf()` の「進行中は失敗より先」は外さない。** そこは原因ではない
 *   (理由は上の 2 つ)。直すのは**何を進行中と数えるか**のほう。
 * ⚠ **黙って消さない。** 取り残しは `failed` に倒す。そうすると画面に「失敗」が出て、
 *   人は「読み取りのやり直し」に進める。数から外すだけだと、ジョブが 1 件も無い案件と
 *   区別が付かなくなる。
 * ⚠ しきい値の正は `shared/ai-jobs.ts` の `JOB_STALE_MS` **1 か所だけ**。
 */
export function foldStale(raw: RawJobCounts): JobCounts {
  const staleQueued = Math.min(raw.staleQueued, raw.queued);
  const staleRunning = Math.min(raw.staleRunning, raw.running);
  return {
    queued: raw.queued - staleQueued,
    running: raw.running - staleRunning,
    failed: raw.failed + staleQueued + staleRunning,
    total: raw.total,
    hasOrderSheet: raw.hasOrderSheet,
  };
}

export function progressOf(counts: JobCounts): CaseProgress | null {
  const { queued, running, failed, total, hasOrderSheet } = counts;

  // ① まだ動いているものがある。**ここが最優先** (ポーリングを止めない)。
  if (running > 0) return "reading";
  if (queued > 0) return "accepted";

  // ② 全部終わっていて、失敗が残っている。
  if (failed > 0) return "failed";

  // ③ 全部成功した。ORDER SHEET が実際に立っているときだけ「書き込んだ」と言う。
  if (total > 0 && hasOrderSheet) return "written";

  /*
   * ④ ジョブが無い (dev-seed の案件 / case_id を足す前のジョブ)、または
   *    全部終わったのに ORDER SHEET が無い (依頼書だけ届いた)。
   *    **どちらも「書き込んだ」ではない。** バッジを出さず、ORDER SHEET 列の
   *    「未作成」に説明を任せる。null にするとポーリングも止まる (追うものが無いので正しい)。
   */
  return null;
}

/** D1 が返す COUNT は number とは限らない (SUM は NULL のことがある)。 */
export function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ── 段 (縦に並べて出す) ──────────────────────────────────────────────────────

/**
 * ★★ 読み取りの**段**。画面はこの順に**縦に並べる**。
 *
 * ⚠⚠ **`CaseProgress`(4 値) とは別物。** あちらはポーリングを続けるかの判断
 *   (`progressOf()`) で、`features/files/schema.ts` の `uploadResult.status` とも
 *   対になっている。**混ぜない。** ここは「人に見せる段」だけ。
 * ⚠ 語彙の日本語は `./format.ts`。`Record<IngestStage, string>` にしてあるので、
 *   ここに足して format を忘れると typecheck で落ちる。
 */
export const INGEST_STAGES = ["classify", "extract", "shape", "done"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

export type StageStatus = "pending" | "running" | "succeeded" | "failed";

/** ai が報告したノード 1 つ (`ai_jobs.progress_json` の中身)。 */
export interface ProgressNode {
  node: string;
  label: string;
  /** ⚠ `done` は入らない (ai は段を 3 つしか報告しない)。 */
  stage: Exclude<IngestStage, "done">;
  status: StageStatus;
  at: number;
}

/** 画面に渡す段 1 つ。`nodes` が入るのは `extract` だけ。 */
export interface IngestStageView {
  stage: IngestStage;
  status: StageStatus;
  /** ⚠ 並列に走るノード。**同時に running が複数**あるのが正しい見え方。 */
  nodes: ProgressNode[];
}

/** ジョブ種別ごとの件数 (`JOB_COUNTS_SQL` が数える)。 */
export interface JobTypeCounts {
  /** `doc_extract` の queued / running / failed / 総数。 */
  extract: { queued: number; running: number; failed: number; total: number };
  /** `order_sheet_generate` の queued / running / failed / 総数。 */
  generate: { queued: number; running: number; failed: number; total: number };
}

/**
 * ⚠ 壊れた JSON でも落ちない。**見せるためだけの値**なので、読めなければ空に倒す。
 * ⚠ 知らない `stage` / `status` の行は捨てる (段の順が崩れるより、出ないほうがよい)。
 */
export function parseProgressNodes(json: string | null | undefined): ProgressNode[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const nodes = (parsed as { nodes?: unknown })?.nodes;
  if (typeof nodes !== "object" || nodes === null) return [];

  const stages = new Set<string>(["classify", "extract", "shape"]);
  const statuses = new Set<string>(["pending", "running", "succeeded", "failed"]);
  const out: ProgressNode[] = [];
  for (const [node, raw] of Object.entries(nodes as Record<string, unknown>)) {
    const value = raw as Partial<ProgressNode>;
    if (typeof value?.label !== "string") continue;
    if (!stages.has(String(value.stage)) || !statuses.has(String(value.status))) continue;
    out.push({
      node,
      label: value.label,
      stage: value.stage as ProgressNode["stage"],
      status: value.status as StageStatus,
      at: typeof value.at === "number" ? value.at : 0,
    });
  }
  // ⚠ **報告の順に並べる** (走り出した順)。鍵の名前で並べると `spec-10` が `spec-2` より前に来る。
  return out.sort((a, b) => a.at - b.at);
}

/** その段のノードから段の状態を決める。⚠ **失敗 > 進行中 > 済 > 待機**。 */
function statusOfNodes(nodes: readonly ProgressNode[]): StageStatus {
  if (nodes.length === 0) return "pending";
  if (nodes.some((n) => n.status === "failed")) return "failed";
  if (nodes.some((n) => n.status === "running")) return "running";
  if (nodes.every((n) => n.status === "succeeded")) return "succeeded";
  return "running";
}

/**
 * ★★ 段を組み立てる。**画面はこれを上から順に縦に並べるだけ。**
 *
 * ⚠⚠ **ai の報告とジョブの件数の両方を使う。**
 *   - `classify` / `extract` … ai が報告したノード (無ければジョブの件数から近似)
 *   - `shape` … ai の `shape` のノード **と** `order_sheet_generate` のジョブ
 *     (ORDER SHEET を組むのは web 側の別ジョブなので、ai だけでは終わらない)
 *   - `done` … ジョブが全部成功して ORDER SHEET が立っている
 * ⚠ **ai が何も報告していないときも段を出す** (戻り道の JSON ルート / 古いジョブ)。
 *   その場合は件数から近似するので、`extract` の内訳 (並列のノード) が出ないだけ。
 * ⚠⚠ **`progressOf()` を呼ばない。** あちらはポーリングの継続判定で、分岐の順に
 *   別の理由がある。ここが増えてもあちらは動かさないこと。
 */
export function stagesOf(input: {
  nodes: readonly ProgressNode[];
  byType: JobTypeCounts;
  hasOrderSheet: boolean;
}): IngestStageView[] {
  const { nodes, byType, hasOrderSheet } = input;
  const at = (stage: ProgressNode["stage"]) => nodes.filter((node) => node.stage === stage);

  const extractDone =
    byType.extract.total > 0 && byType.extract.queued + byType.extract.running === 0;
  const generateDone =
    byType.generate.total > 0 && byType.generate.queued + byType.generate.running === 0;
  const allDone = extractDone && generateDone && hasOrderSheet;

  /** ai が黙っているときの近似。⚠ 嘘にならない範囲でしか進めない。 */
  const approximate = (stage: ProgressNode["stage"]): StageStatus => {
    if (byType.extract.total === 0) return "pending";
    if (extractDone) return byType.extract.failed > 0 && stage !== "shape" ? "failed" : "succeeded";
    // ⚠ 読み取りが走っている間は、分類と抽出の境目が外からは見えない。
    //   **「分類中」と言い切らない**ために、どちらも running にしておく。
    return byType.extract.running > 0 ? "running" : "pending";
  };

  const stageOf = (stage: ProgressNode["stage"]): IngestStageView => {
    const own = at(stage);
    return {
      stage,
      status: own.length > 0 ? statusOfNodes(own) : approximate(stage),
      nodes: own,
    };
  };

  const shape = stageOf("shape");
  return [
    stageOf("classify"),
    stageOf("extract"),
    {
      ...shape,
      /*
       * ⚠⚠ **ORDER SHEET を組むのは web の別ジョブ** (`order_sheet_generate`)。
       *   ai の `link` が済んでも、生成ジョブが残っていればまだ「整形中」。
       */
      status:
        shape.status === "succeeded" && !generateDone
          ? byType.generate.total > 0
            ? "running"
            : "pending"
          : shape.status,
    },
    {
      stage: "done",
      status: allDone
        ? "succeeded"
        : byType.extract.failed + byType.generate.failed > 0 && extractDone && generateDone
          ? "failed"
          : "pending",
      nodes: [],
    },
  ];
}
