import { z } from "zod";
import { INGEST_STAGES } from "./lib/progress";

/**
 * ★ 取り込みの進み具合。**この語彙の正はここ 1 か所** (cases 側)。
 *
 * ⚠⚠ **同じ語彙が `features/files/schema.ts` の `uploadResult.status` にもある。**
 *   アップロードの 202 が返す値で、取り込み側 (files) の契約なので別に持っている。
 *   ESLint の boundaries が feature 間の import を `import type` でも禁じているため、
 *   1 か所にはまとめられない。**片方を変えるなら両方変えること。**
 *   ずれは両 feature の schema.test.ts が名指しで落とす。
 * ⚠ 日本語の見出しは `lib/format.ts` の `PROGRESS`。`Record<CaseProgress, string>` なので、
 *   ここに値を足して向こうを忘れると typecheck で落ちる。
 * ⚠ ai_jobs.status からの写像と集約は `lib/progress.ts` が持つ (画面にも SQL にも書かない)。
 */
export const progressSchema = z.enum(["accepted", "reading", "written", "failed"]);
export type CaseProgress = z.infer<typeof progressSchema>;

/** 案件一覧の 1 行。 */
export const caseRowSchema = z.object({
  caseId: z.string(),
  /** 案件番号。無ければ製造番号で表す (案件番号は採番しないため)。 */
  caseLabel: z.string(),
  partnerName: z.string(),
  /**
   * 発注No (お客様の発注書の右上に印字されている番号)。
   * ⚠ **まだ読めていなければ null。**「0 件」と混ぜない (画面では「未取得」と出す)。
   */
  customerPoNo: z.string().nullable(),
  /** 届いている発注書の通数。 */
  purchaseOrderCount: z.number().int(),
  /** 届いている依頼書の通数。 */
  revisionRequestCount: z.number().int(),
  /** ORDER SHEET の状態。まだ 1 枚も無ければ null。 */
  orderSheetStatus: z.string().nullable(),
  /** ⚠ 出荷日。**空が正常** (営業が決める欄)。 */
  shipDate: z.string().nullable(),
  updatedAt: z.string(),
  /**
   * 取り込みの進み具合。一覧の行に出す (時間がかかるので画面を待たせない)。
   * ⚠ null = 追うべきジョブが無い。**バッジを出さない**ので、3 秒ポーリングも止まる。
   */
  progress: progressSchema.nullable(),
});
export type CaseRow = z.infer<typeof caseRowSchema>;

export const caseDetailSchema = z.object({
  caseId: z.string(),
  caseLabel: z.string(),
  partnerName: z.string(),
  specNo: z.string().nullable(),
  status: z.string(),
  updatedAt: z.string(),
  /**
   * ★ **いま走っている読み取りジョブの id**。無ければ null。
   *
   * ⚠⚠ **画面を離れても読み取りは止まらない** (走るのはキューの consumer)。
   *   戻ってきた画面がこれを拾って追い直すので、**再読み込みしてもスピナーが出る**。
   *   これが無いと、アップロード / やり直しの直後にしか「読み取り中」が出ない。
   */
  ingestingJobId: z.string().nullable(),
});
export type CaseDetail = z.infer<typeof caseDetailSchema>;

/**
 * ★ 案件を起こす入力（`POST /api/cases` と RPC の `CasesEntrypoint.createCase`）。
 *
 * ⚠⚠ **取り込みパイプライン専用。** 画面に「案件を作る」導線は足さない（案件番号は採番しない。
 *   人に案件番号を決めさせない）。帳票が届いて案件が起きる経路だけがここを通る。
 * ⚠ **すべて任意。** 取り込みは**アップロードの時点で**呼ぶので、その時点では取引先も
 *   製造番号もまだ読めておらず、本文は `{}` で来る。**ここで 400 を返すとアップロードが
 *   502 で落ちる**（しかも R2 のオブジェクトは巻き戻らない）。
 * ⚠ `partner` は取引先の**名前・コードの文字列**で、`partnerId` ではない。形を持っているのは
 *   取り込み側の `purchase-orders/services/case-client.ts` なので、変えると契約違反になる。
 * ⚠ 欄ごとに `.catch(undefined)` を付けてあるのは、**片方の型が違っても、もう片方を
 *   道連れにしない**ため。
 */
export const createCaseInput = z.object({
  partner: z.string().optional().catch(undefined),
  specNo: z.string().optional().catch(undefined),
});
export type CreateCaseInput = z.infer<typeof createCaseInput>;

/**
 * 読み取りが終わってから案件を埋める入力（`PATCH /api/cases/:caseId`）。
 *
 * ⚠ 取引先と製造番号が分かるのは**読み取りの後**。これが無いと案件一覧が
 *   「取引先未確定」のままになる。
 * ⚠ POST と違い、ここは厳しくてよい（意図した書き込みなので、形が違えば 400 が正しい）。
 */
export const updateCaseInput = z.object({
  partnerId: z.string().min(1).optional(),
  specNo: z.string().min(1).optional(),
  caseNo: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
export type UpdateCaseInput = z.infer<typeof updateCaseInput>;

/**
 * ジョブ 1 件の状態 (`GET /api/cases/jobs/:jobId`)。
 *
 * ⚠⚠ **一覧 (`GET /api/cases`) は 4 つの JOIN が走る重いクエリ。** アップロード直後に
 *   追いたいのは「そのジョブ 1 件」だけなので、軽い口を分けてある。
 * ⚠ `jobStatus` は ai_jobs の生の状態、`progress` は**その案件の集約**。別物。
 *   読み取りジョブ 1 件の `succeeded` は「ORDER SHEET に書き込んだ」を意味しない
 *   (読み取りの後に生成ジョブが別に積まれるため)。画面が見るのは `progress` のほう。
 * ⚠ `jobStatus` は `z.string()`。ai_jobs の状態が増えても画面は落ちない。
 */
export const jobStatusResult = z.object({
  jobId: z.string(),
  /** ⚠ nullable。case_id の列を足す前に積まれたジョブが残っている。 */
  caseId: z.string().nullable(),
  jobStatus: z.string(),
  progress: progressSchema.nullable(),
  /**
   * ★ **いつから読み取り中か** (ISO 8601)。進行中のジョブが無ければ null。
   * ⚠ 回り続けるスピナーしか手がかりが無いと、人は取り残しに気づけない。
   *   **取り残し (`JOB_STALE_MS` 超え) はここに出ない** — それは `failed` に倒れるため。
   */
  ingestingSince: z.string().nullable(),
  /**
   * ★★ 読み取りの**段**。画面はこれを上から順に**縦に並べる**。
   *
   * ⚠⚠ **`progress` (4 値) を置き換えない。足すだけ。** ポーリングの継続判定
   *   (`use-cases.ts`) と `ingesting` はあちらで動いている。
   * ⚠ ノードが入るのは `extract` だけ。**並列に走っているぶんは同時に running**。
   * ⚠ ai が何も報告していないとき (戻り道の JSON ルート / 古いジョブ) でも段は出る。
   *   内訳 (`nodes`) が空になるだけ。
   */
  stages: z.array(
    z.object({
      stage: z.enum(INGEST_STAGES),
      status: z.enum(["pending", "running", "succeeded", "failed"]),
      nodes: z.array(
        z.object({
          node: z.string(),
          label: z.string(),
          stage: z.enum(["classify", "extract", "shape"]),
          status: z.enum(["pending", "running", "succeeded", "failed"]),
          at: z.number(),
        }),
      ),
    }),
  ),
});
export type JobStatusResult = z.infer<typeof jobStatusResult>;
