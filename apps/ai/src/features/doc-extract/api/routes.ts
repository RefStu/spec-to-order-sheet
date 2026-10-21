import { registerApiRoute } from "@mastra/core/server";
import { describeError } from "../../../shared/errors";
import { docExtractPath, docExtractRequestSchema, docExtractStreamPath } from "../contract";
import { documentExtractWorkflow } from "../workflows/document-extract";

/**
 * 帳票 (発注書・新製品依頼書) の読み取り。**入口はこの 1 本だけ。**
 *
 * ⚠ **stream しない。** これを呼ぶのは web の Queue consumer で、画面ではないため。
 * ⚠ Cloud Run はリクエストの外で CPU が絞られるので、読み終わるまで待ってから返す。
 * ⚠ **runId に jobId を使う。** retry で同じ run を再開できる。
 */
export const docExtractRoute = registerApiRoute(docExtractPath, {
  method: "POST",
  handler: async (c) => {
    const parsed = docExtractRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const workflow = c.get("mastra").getWorkflowById(documentExtractWorkflow.id);
    const run = await workflow.createRun({ runId: parsed.data.jobId });
    const result = await run.start({
      inputData: parsed.data,
      requestContext: c.get("requestContext"),
      /**
       * ★★ **トレースの根はここで決まる。**
       *
       * ⚠ 中の `agent.generate` にだけ渡しても効かない (workflow の span が既に根なので、
       *   agent の呼び出しはその子になる)。実機で確かめた: 渡さないと Mastra が
       *   自分で ID を作り、`ai_jobs.trace_id` と突き合わせられなくなる。
       * ⚠ Mastra は `traceparent` ヘッダを自分では拾わないので、web が作った ID を明示的に渡す。
       */
      ...(parsed.data.tracingOptions ? { tracingOptions: parsed.data.tracingOptions } : {}),
    });

    if (result.status !== "success") {
      // ⚠⚠ **`String(error)` にしない。** Mastra が投げるのはプレーンなオブジェクトのことがあり、
      //   `"[object Object]"` になって**失敗の理由が丸ごと消える**
      //   (web 側には `ai が 500 を返しました: {"error":"[object Object]"}` しか残らない)。
      const error = result.status === "failed" ? describeError(result.error) : result.status;
      return c.json({ error }, 500);
    }
    return c.json(result.result);
  },
});

/**
 * ★★ 進捗つきの読み取り (NDJSON)。**web の Queue consumer が読む。**
 *
 * ⚠⚠ **上の `docExtractRoute` を消さないこと。** あちらは `run.start()` のままで、
 *   こちらが通らなくなったときの戻り道。
 * ⚠ 流すのは **step が `writer.write()` した進捗**と、**最後の 1 行の結果**だけ。
 *   Mastra が流す他のチャンク (`workflow-step-start` やモデルの出力) は捨てる
 *   — 受け手は consumer で、巨大な本文を中継させる意味が無い。
 * ⚠⚠ **`tracingOptions` はここにも渡す。** トレースの根を決めるのは `run.stream()` の
 *   ほうなので、渡し忘れると `ai_jobs.trace_id` と突き合わせられなくなる。
 * ⚠ 失敗は **HTTP のステータスでは伝えられない** (ヘッダはもう出ている)。
 *   最後の 1 行を `{"type":"error"}` にして、consumer がそれを見て retry する。
 * ⚠⚠ **`String(error)` にしない** (`describeError()`)。Mastra はプレーンなオブジェクトを
 *   投げることがあり、`"[object Object]"` になって理由が丸ごと消える。
 */
export const docExtractStreamRoute = registerApiRoute(docExtractStreamPath, {
  method: "POST",
  handler: async (c) => {
    const parsed = docExtractRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const workflow = c.get("mastra").getWorkflowById(documentExtractWorkflow.id);
    // ⚠ runId に jobId を使う (retry で同じ run を再開できる)。上のルートと同じ。
    const run = await workflow.createRun({ runId: parsed.data.jobId });
    const requestContext = c.get("requestContext");
    const tracingOptions = parsed.data.tracingOptions;

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const line = (value: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        try {
          const output = run.stream({
            inputData: parsed.data,
            requestContext,
            ...(tracingOptions ? { tracingOptions } : {}),
          });

          /*
           * ⚠ step が `writer.write(x)` したものは、workflow の stream には
           *   `{ type: "workflow-step-output", payload: { output: x } }` として現れる
           *   (`@mastra/core` の `ToolStream._write`)。**進捗だけを抜き出す。**
           */
          for await (const chunk of output.fullStream) {
            const event = (chunk as { payload?: { output?: { type?: string } } }).payload?.output;
            if (chunk.type === "workflow-step-output" && event?.type === "progress") line(event);
          }

          const result = await output.result;
          if (result.status !== "success") {
            const error = result.status === "failed" ? describeError(result.error) : result.status;
            line({ type: "error", error });
          } else {
            line({ type: "result", result: result.result });
          }
        } catch (error) {
          line({ type: "error", error: describeError(error) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        // ⚠ 途中まで溜めさせない (ゲートウェイも Cloud Run も素通しする形にする)。
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  },
});

export const docExtractApiRoutes = [docExtractRoute, docExtractStreamRoute];
