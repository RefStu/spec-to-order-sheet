import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { aiJobs } from "../db/schema";
import type { DocExtractProgress } from "../lib/ai-contract";
import { newTraceId } from "../lib/trace-id";
import { uuidv7 } from "../lib/uuid-v7";
import type { JobMessage } from "../queues/message";

type JobType = typeof aiJobs.$inferInsert.jobType;
type TargetKind = typeof aiJobs.$inferInsert.targetKind;

/**
 * 読み取りの仕事を積む。
 *
 * ⚠ **D1 に先に書いてからキューに積む。** 逆にすると、行がまだ無いうちに consumer が
 *   走って「ジョブが見つからない」で落ちる。
 * ⚠ ここから Cloud Run を直接呼ばない。読み取りは分単位かかることがあり、
 *   Worker のリクエストの実行時間に収まらない。
 */
export async function enqueueJob(
  env: Bindings,
  input: {
    jobType: JobType;
    targetKind: TargetKind;
    targetId: string;
    caseId: string;
    inputFileId?: string;
  },
): Promise<string> {
  const db = createDb(env);
  const jobId = uuidv7();

  await db.insert(aiJobs).values({
    id: jobId,
    jobType: input.jobType,
    status: "queued",
    targetKind: input.targetKind,
    targetId: input.targetId,
    // ⚠ 案件からジョブへ辿れるのはこの列だけ (po_documents に case_id が無い)。
    //   案件一覧の「進み具合」がこれを読むので、必ず入れること。
    caseId: input.caseId,
    inputFileId: input.inputFileId ?? null,
    // ★ 観測のトレース ID。**ここで作って D1 に残す**ので、Langfuse で追えない部分も
    //   `ai_jobs` から突き合わせられる (列はあるのに一度も書かれていなかった)。
    traceId: newTraceId(),
    queuedAt: new Date(),
  });

  const message: JobMessage = { jobId, caseId: input.caseId };
  await env.JOBS_QUEUE.send(message);
  return jobId;
}

export async function markJobRunning(env: Bindings, jobId: string, attempt: number): Promise<void> {
  await createDb(env)
    .update(aiJobs)
    .set({
      status: "running",
      startedAt: new Date(),
      attempt,
      // ⚠⚠ **やり直しのたびに進捗を空に戻す。** 残すと、前回の「済」が最初から点いたまま
      //   出て、いま何をしているのか分からなくなる。
      progressJson: null,
    })
    .where(eq(aiJobs.id, jobId));
}

/**
 * ★★ 読み取りの**段の進み具合**を 1 件書き足す (画面のポーリングが読む)。
 *
 * ⚠⚠ **UPDATE 1 発に抑える。** ノードごとに行を増やす形にしない
 *   (`ai_extraction_fields` と違って、これは見せるためだけの状態)。
 * ⚠ **`node` を鍵に上書きする。** 同じノードの running → succeeded は 1 件に畳む。
 * ⚠⚠ **失敗させない。** 進捗の書き込みで throw すると、`message.retry()` で
 *   **読み取りごとやり直し**になる。進捗は落ちてよいもの。
 * ⚠ 触るのは 1 つの consumer だけなので、読んで書き戻す形で競合しない。
 */
export async function recordJobProgress(
  env: Bindings,
  jobId: string,
  event: DocExtractProgress,
): Promise<void> {
  try {
    const db = createDb(env);
    const [row] = await db
      .select({ progressJson: aiJobs.progressJson })
      .from(aiJobs)
      .where(eq(aiJobs.id, jobId))
      .limit(1);

    const nodes: Record<string, unknown> = { ...readNodes(row?.progressJson ?? null) };
    nodes[event.node] = {
      label: event.label,
      stage: event.stage,
      status: event.status,
      at: event.at,
    };
    await db
      .update(aiJobs)
      .set({ progressJson: JSON.stringify({ nodes }) })
      .where(eq(aiJobs.id, jobId));
  } catch (error) {
    console.warn(`[ai-review] ${jobId} の進捗を残せませんでした`, error);
  }
}

/** ⚠ 壊れた JSON でも落ちない (見せるためだけの値なので、空に倒す)。 */
function readNodes(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    const nodes = (parsed as { nodes?: unknown })?.nodes;
    return typeof nodes === "object" && nodes !== null ? (nodes as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function markJobSucceeded(
  env: Bindings,
  jobId: string,
  meta: {
    modelName: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  },
): Promise<void> {
  await createDb(env)
    .update(aiJobs)
    .set({
      status: "succeeded",
      finishedAt: new Date(),
      modelName: meta.modelName,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      // ⚠ 費用と時間は合否に使わない。運用の見積もりの材料として残すだけ。
      latencyMs: meta.latencyMs,
      // ⚠ **前の試行の理由を消す。** 再試行や `cancelInProgressJobs` で `failed` に
      //   なった行がそのまま成功に戻ると、`succeeded` なのに「取り消しました」という
      //   文言だけが残って読み手を惑わせる (実測で見た)。
      errorMessage: null,
    })
    .where(eq(aiJobs.id, jobId));
}

export async function markJobFailed(env: Bindings, jobId: string, error: string): Promise<void> {
  await createDb(env)
    .update(aiJobs)
    .set({ status: "failed", finishedAt: new Date(), errorMessage: error.slice(0, 2000) })
    .where(eq(aiJobs.id, jobId));
}

/**
 * ★ その対象の**進行中のジョブを畳む** (読み取りをやり直すときに呼ぶ)。
 *
 * ⚠⚠ **進行中のまま誰も畳まない行が実在する。** consumer のプロセスが落ちると
 *   `markJobFailed()` を呼ぶ者が居なくなり、`running` の行だけが残る。取り残しが 1 つでも
 *   あると、その案件は永遠に「読み取り中」に見える (`cases/lib/progress.ts`)。
 *   **やり直すときが、人が自分で抜け出せる唯一の導線**なのでここで畳む。
 * ⚠ 畳むのは **ジョブの行だけ**。読み取った結果 (`ai_extractions` の版) には触らない
 *   (`reextractDocument` の「先に消さない」設計を壊さないこと)。
 * ⚠ 新しいジョブを積む**前に**呼ぶこと。後だと積んだばかりの行まで畳む。
 * ⚠ **走っている仕事そのものは止まらない。** 畳むのは D1 の行だけなので、すでに ai へ
 *   投げてある読み取りは最後まで走り、終われば `markJobSucceeded` がこの行を
 *   `succeeded` に戻す。それでかまわない — 結果の書き込みは版で管理されていて
 *   (`recordExtraction` が version を上げる)、**新しいほうが後から勝つ**。
 *   ここで止めたいのは「誰も畳まない行が居座ること」であって、仕事そのものではない。
 *
 * @returns 畳んだ件数
 */
export async function cancelInProgressJobs(
  env: Bindings,
  target: { targetKind: TargetKind; targetId: string },
  reason: string,
): Promise<number> {
  const result = await createDb(env)
    .update(aiJobs)
    .set({ status: "failed", finishedAt: new Date(), errorMessage: reason.slice(0, 2000) })
    .where(
      and(
        eq(aiJobs.targetKind, target.targetKind),
        eq(aiJobs.targetId, target.targetId),
        inArray(aiJobs.status, ["queued", "running"]),
      ),
    )
    .returning({ id: aiJobs.id });
  return result.length;
}

export async function getJob(env: Bindings, jobId: string) {
  const [job] = await createDb(env).select().from(aiJobs).where(eq(aiJobs.id, jobId)).limit(1);
  return job ?? null;
}
