import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import type { Bindings } from "../shared/hono";
import { dispatchQueue } from "../shared/queue";
import { queueConsumers } from "./queues.gen";
import { featureApi } from "./routes.gen";

/**
 * Worker の entry (wrangler.jsonc の main)。
 *
 * ⚠ **ここに feature を書かない。** API は routes.gen.ts、Queue の consumer は
 *   queues.gen.ts (どちらも `make gen` が生成) 経由で読む。手で足すと生成物とずれる。
 * ⚠ アセット (React SPA) は wrangler.jsonc の assets が先に返す。Worker まで来るのは
 *   run_worker_first に書いた /api/* だけ。
 */

/** hc<AppType> 用。SPA 側は shared/api-client.ts がこれを使う。 */
export type { AppType } from "./routes.gen";

/**
 * service binding (RPC) の口。**Worker の entry から named export されていないと束ねられない。**
 *
 * ⚠ 中身は entrypoints.gen.ts が集める。**ここに feature を直接書かないこと。**
 * ⚠ wrangler.jsonc の services[].entrypoint と同じクラス名であること。
 */
export * from "./entrypoints.gen";

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
    return featureApi.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: Bindings, ctx: ExecutionContext): Promise<void> {
    await dispatchQueue(queueConsumers, batch, env, ctx);
  },
};
