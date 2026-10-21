import { and, eq, isNull } from "drizzle-orm";
import { fetchAi } from "../../../shared/ai/ai-client";
import { createDb } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { defineQueueConsumer } from "../../../shared/queue";
import { files } from "../../files/db/schema";
import { readBytes, storePhoto } from "../../files/services/upload-service";
import { poDocuments } from "../../purchase-orders/db/schema";
import { writeExtractedDocument } from "../../purchase-orders/services/document-writer";
import {
  OrderSheetNotGeneratable,
  generateOrderSheet,
} from "../../order-sheets/services/order-sheet-generator";
import { base64ToBytes, bytesToBase64 } from "../lib/base64";
import {
  DOC_EXTRACT_STREAM_PATH,
  docExtractStreamLine,
  type DocExtractResult,
} from "../lib/ai-contract";
import { recordExtraction, recordOrderSheetFields } from "../services/extraction-recorder";
import {
  enqueueJob,
  getJob,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  recordJobProgress,
} from "../services/job-service";
import { jobMessage } from "./message";

/**
 * 読み取りのジョブを Cloud Run に投げ、結果を D1 に書き戻す。
 *
 * ⚠ **キューは AI 専用で 1 本、consumer も 1 つ。** Worker が持てる queue ハンドラは
 *   1 つだけで、`app/queues.gen.ts` が **queue 名**で振り分けるため。
 *   `queue` は wrangler.jsonc の queues.consumers[].queue と**同じ文字列**にする
 *   (ずれるとデプロイは成功したまま全メッセージが DLQ に落ちる)。
 * ⚠ **AI を Cloud Run に置いてあるのは**、読み取りに時間がかかり Workers の実行時間と
 *   CPU の制限に収まらないため。
 * ⚠ 形が違うメッセージは `ack()`(再試行しても直らない)、処理に失敗したものは `retry()`。
 */
export const consumer = defineQueueConsumer({
  queue: "spec-to-order-sheet-jobs",
  handle: async (batch, env) => {
    for (const message of batch.messages) {
      const parsed = jobMessage.safeParse(message.body);
      if (!parsed.success) {
        console.error("[ai-review] 不正なメッセージ", parsed.error.issues);
        message.ack();
        continue;
      }
      const { jobId, caseId } = parsed.data;

      try {
        const job = await getJob(env, jobId);
        if (!job) {
          console.error(`[ai-review] ai_jobs に見つかりません: ${jobId}`);
          message.ack();
          continue;
        }
        await markJobRunning(env, jobId, message.attempts);
        await runJob(env, { job, caseId });
        message.ack();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await markJobFailed(env, jobId, reason);
        await markDocumentFailed(env, parsed.data.jobId);
        console.error(`[ai-review] ${jobId} の読み取りに失敗`, error);
        message.retry();
      }
    }
  },
});

type Job = NonNullable<Awaited<ReturnType<typeof getJob>>>;

async function runJob(env: Bindings, input: { job: Job; caseId: string }): Promise<void> {
  const { job, caseId } = input;

  // ORDER SHEET の生成は読み取りとは別のジョブ。
  if (job.jobType === "order_sheet_generate") return runOrderSheetGenerate(env, { job, caseId });

  // ⚠ `po_extract` / `spec_sheet_extract` は**積まれたままの古いジョブ**のために残す。
  //   新しく積むのは `doc_extract` だけで、経路は 1 本しかない。
  if (
    job.jobType !== "doc_extract" &&
    job.jobType !== "po_extract" &&
    job.jobType !== "spec_sheet_extract"
  ) {
    // PoC で consumer が扱うのは、読み取りと ORDER SHEET の生成だけ。
    throw new Error(`このジョブ種別は扱いません: ${job.jobType}`);
  }

  const document = await loadDocument(env, job.targetId);
  const body = await readBytes(env, document.storageKey);
  if (!body) throw new Error(`R2 に原本がありません: ${document.storageKey}`);

  await createDb(env)
    .update(poDocuments)
    .set({ status: "parsing" })
    .where(eq(poDocuments.id, document.documentId));

  /*
   * ⚠⚠ **指示文も様式の候補も渡さない。** 「この様式のときはこの指示文」を D1 で持つ形は
   *   やめて、**ai のファイル (git) が正**になった。
   *   画面「発注書分類」は表として残してあるが、**読み取りには効かない**。
   */
  // ⚠ PDF は base64 にして JSON に埋める (ai-client は JSON しか送れない)。
  //   ⚠ String.fromCharCode(...bytes) を使わないこと (スタックが溢れる)。
  const dataBase64 = bytesToBase64(new Uint8Array(body));

  const response = await fetchAi(env, {
    path: DOC_EXTRACT_STREAM_PATH,
    body: {
      jobId: job.id,
      filename: document.originalFilename,
      mediaType: document.contentType,
      dataBase64,
      // ★ **1 アップロード = 1 トレース。** Mastra は traceparent を自分では拾わないので、
      //   web が作った ID を明示的に渡す (`ai_jobs.trace_id` と同じ値)。
      ...(job.traceId
        ? {
            tracingOptions: {
              traceId: job.traceId,
              metadata: { sessionId: caseId, jobId: job.id },
              tags: ["doc-extract"],
            },
          }
        : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`ai が ${response.status} を返しました: ${await response.text()}`);
  }

  // ★★ 読みながら進捗を D1 に書き、最後の 1 行で結果を受け取る。
  const result = await readExtraction(env, job.id, response);

  // ★★ 発注書 1 通 + 依頼書 n 枚を **1 つの batch** で書き直す。
  const written = await writeExtractedDocument(env, {
    poDocumentId: document.documentId,
    caseId,
    aiJobId: job.id,
    extraction: result.extraction,
  });

  // ★ 切り出せた代表の図を R2 に預ける。**batch の外** (R2 は D1 の batch に入らない)。
  //   ⚠ 依頼書と写真は**添字**で対応する (`written.revisionRequestIds` は specSheets と同じ順)。
  //   ⚠ ここで throw しない。写真が無くても ORDER SHEET は作れる (欄が空になるだけ)。
  for (const picture of result.extraction.pictures) {
    const revisionRequestId = written.revisionRequestIds[picture.specSheetIndex];
    if (!revisionRequestId) continue;
    try {
      await storePhoto(env, {
        revisionRequestId,
        // ⚠ **何枚目かを渡さないと全部同じ鍵になり、最後の 1 枚だけが残る。**
        pictureIndex: picture.pictureIndex,
        body: base64ToBytes(picture.dataBase64),
        contentType: picture.mediaType,
      });
    } catch (error) {
      console.warn(`[ai-review] ${caseId} の代表の図を預けられませんでした`, error);
    }
  }

  // 読み取って初めて取引先と製造番号が分かる。案件に返さないと一覧が仮のまま。
  await updateCase(env, caseId, {
    partnerId: written.partnerId ?? undefined,
    specNo: written.specNo ?? undefined,
  });

  // ⚠ **欄 1 つ = 1 行** の記録。これが無いと塗り分けも正答率も出せない。
  await recordExtraction(env, {
    aiJobId: job.id,
    poDocumentId: document.documentId,
    rawOutput: result.rawOutput,
    fields: written.fields,
  });

  /**
   * ORDER SHEET の生成を**別のジョブ**として積む。
   *
   * ⚠⚠ **ここで同期的に組まないこと。** 生成で throw すると `message.retry()` により
   *   読み取りごとやり直しになる。別ジョブなら失敗を切り離せる。
   * ⚠ `generateOrderSheet()` は冪等なので、どれが最後でも同じ 1 枚に収束する。
   * ⚠⚠ **`markJobSucceeded` より「先」に積む。** 後ろに置くと、その隙間では
   *   queued も running も 0 になり、`progressOf()` (cases/lib/progress.ts) が
   *   「全ジョブ終了」(`written` / `null`) を返す。画面のポーリングはそこで止まるので、
   *   **そのあと生成ジョブが ORDER SHEET を書いても画面は一生知らない**
   *   (リロードで初めて出る)。
   * ⚠ 生成が読むのは発注書・依頼書のテーブルだけで `ai_jobs.status` は見ないので、
   *   先に積んでも取れるデータは変わらない (書き込みは既に上で済んでいる)。
   */
  try {
    await enqueueJob(env, {
      jobType: "order_sheet_generate",
      targetKind: "order_sheet",
      // ⚠ ORDER SHEET はまだ無いことがあるので、案件を対象にする。
      targetId: caseId,
      caseId,
    });
  } catch (error) {
    // ⚠ **ここで投げない。** 読み取りは既に D1 に入っている。積めなかったときは
    //   ORDER SHEET が遅れるだけで、次の帳票の読み取りか「やり直す」で組み直せる。
    console.warn(`[ai-review] ${caseId} の ORDER SHEET 生成を積めませんでした`, error);
  }

  await markJobSucceeded(env, job.id, {
    modelName: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    // ⚠ `promptId` は渡さない。指示文は ai のファイル (git) が正で、`ai_prompts` の行を
    //   指していないため (`ai_jobs.prompt_id` は `ai_prompts.id` への外部キー)。
  });
}

/**
 * 案件 1 件から ORDER SHEET を 1 枚起こし、8 欄の記録を残す。
 *
 * ⚠ 発注書がまだ 1 通も読めていないときは**失敗ではない** (依頼書だけ先に読み終わった)。
 *   `succeeded` で畳んで次の帳票の生成ジョブに任せる。retry すると無駄に回り続ける。
 */
async function runOrderSheetGenerate(
  env: Bindings,
  input: { job: Job; caseId: string },
): Promise<void> {
  const { job, caseId } = input;
  const startedAt = Date.now();

  let result;
  try {
    result = await generateOrderSheet(env, { caseId, aiJobId: job.id });
  } catch (error) {
    if (error instanceof OrderSheetNotGeneratable) {
      console.info(`[ai-review] ${caseId} はまだ ORDER SHEET を組めません: ${error.message}`);
      await markJobSucceeded(env, job.id, {
        modelName: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }
    throw error;
  }

  // ⚠ **欄 1 つ = 1 行。** これが無いと画面の塗り分けも正答率も出せない。
  // ⚠ recordExtraction() ではなく専用の口を使う (あちらは読み取りの版を巻き添えで降ろす)。
  await recordOrderSheetFields(env, {
    aiJobId: job.id,
    caseId,
    rawOutput: result.rawOutput,
    fields: result.fields,
  });

  await markJobSucceeded(env, job.id, {
    modelName: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: Date.now() - startedAt,
  });
}

/**
 * 読み取って分かったことを案件に返す。
 *
 * ⚠⚠ **service binding (RPC) で呼ぶ。** HTTP ではない。取引先と製造番号が分かるのは
 *   ここ (キューの consumer) で、利用者のリクエストが無いので絶対 URL も Authorization も
 *   作れない。RPC は `fetch` ハンドラを通らないので `authMiddleware` も通らず、
 *   **パイプラインに資格情報を持たせずに済む** (誰が呼べるかは wrangler.jsonc の宣言だけ)。
 * ⚠⚠ **失敗しても読み取りは成功扱いにする。** ここで throw すると `message.retry()` で
 *   読み取りごとやり直しになり、`writePurchaseOrder()` が毎回新しい行を作るので
 *   **同じ帳票から 2 通目ができる**。案件の表示が仮のままになるだけなので、警告で済ませる。
 * ⚠ `cases` は別の feature の持ち物。DB は直接触らず、`cases` が出している RPC の面だけを使う。
 */
async function updateCase(
  env: Bindings,
  caseId: string,
  patch: { partnerId?: string; specNo?: string },
): Promise<void> {
  // 空の本文で呼ばない (A 側は min(1) で弾く)。
  if (!patch.partnerId && !patch.specNo) return;

  try {
    const ok = await env.CASES.updateCase(caseId, patch);
    if (!ok) {
      console.warn(`[ai-review] 案件 ${caseId} を更新できませんでした (案件か取引先が無い)`);
    }
  } catch (error) {
    console.warn(`[ai-review] 案件 ${caseId} の更新に失敗しました`, error);
  }
}

async function loadDocument(env: Bindings, documentId: string) {
  const [row] = await createDb(env)
    .select({
      documentId: poDocuments.id,
      storageKey: files.storageKey,
      originalFilename: files.originalFilename,
      contentType: files.contentType,
    })
    .from(poDocuments)
    .innerJoin(files, eq(files.id, poDocuments.fileId))
    // ⚠ 消された帳票のジョブが残っていることがある (消す前に積まれたもの)。読みに行かない。
    .where(and(eq(poDocuments.id, documentId), isNull(poDocuments.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`po_documents に見つかりません: ${documentId}`);
  return row;
}

/** 失敗を原本にも残す (画面が「読み取りに失敗」と出せるように)。 */
async function markDocumentFailed(env: Bindings, jobId: string): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job || job.targetKind !== "po_document") return;
  await createDb(env)
    .update(poDocuments)
    .set({ status: "failed" })
    .where(eq(poDocuments.id, job.targetId));
}

/**
 * ★★ ai の NDJSON を**読み進めながら**進捗を D1 に書き、結果を返す。
 *
 * ⚠⚠ **結果の行が来ないまま終わったら失敗にする。** 途中で切れた stream を成功に
 *   すると、読めていない帳票が `succeeded` で畳まれて**人が気づけない**。
 * ⚠⚠ **進捗の書き込みで throw しない** (`recordJobProgress` が中で飲む)。
 *   ここで落とすと `message.retry()` で読み取りごとやり直しになる。
 * ⚠ 行の分割は自前 (`TextDecoder` + 改行)。**新しい依存を足さない。**
 * ⚠ 形が違う行は**捨てる**。ai が新しい種類の行を足しても、古い web が落ちないように。
 */
async function readExtraction(
  env: Bindings,
  jobId: string,
  response: Response,
): Promise<DocExtractResult> {
  if (!response.body) throw new Error("ai が本文を返しませんでした");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: DocExtractResult | undefined;
  let failure: string | undefined;

  const handle = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (text.length === 0) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      console.warn(`[ai-review] ${jobId}: 読めない行が来ました`);
      return;
    }
    const line = docExtractStreamLine.safeParse(json);
    // ⚠ 知らない形の行は捨てる (ai が種類を足しても web は落ちない)。
    if (!line.success) return;
    if (line.data.type === "progress") return recordJobProgress(env, jobId, line.data);
    if (line.data.type === "error") {
      failure = line.data.error;
      return;
    }
    result = line.data.result;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      await handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  // ⚠ 最後の行に改行が付かないことがある。
  await handle(buffer + decoder.decode());

  if (failure !== undefined) throw new Error(`ai の読み取りが失敗しました: ${failure}`);
  if (!result) throw new Error("ai の応答が途中で切れました (結果の行が来ていません)");
  return result;
}
