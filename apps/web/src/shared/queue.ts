import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import type { Bindings } from "./hono";

/**
 * Queue の consumer。
 *
 * ⚠ Worker が持てる `queue` ハンドラは **1 つだけ** なので、feature ごとの consumer を
 *   app/queues.gen.ts に集め、worker.ts が queue 名で振り分ける。
 * ⚠ body の型は `unknown` にしてある。キューを通った値は JSON として戻ってきただけで、
 *   型は保証されない。**受け取った側が zod で検証すること。**
 */
export interface QueueConsumer {
  /** wrangler.jsonc の queues.consumers[].queue と一致させる。 */
  queue: string;
  handle: (batch: MessageBatch<unknown>, env: Bindings, ctx: ExecutionContext) => Promise<void>;
}

export function defineQueueConsumer(consumer: QueueConsumer): QueueConsumer {
  return consumer;
}

/**
 * その consumer が受け持つ queue 名か。
 *
 * ⚠ **startsWith にしないこと。** `jobs` と `jobs-archive` が誤って一致する。
 */
export function matchesQueue(consumerQueue: string, actualQueue: string): boolean {
  return consumerQueue === actualQueue;
}

/** batch.queue に対応する consumer を呼ぶ。 */
export async function dispatchQueue(
  consumers: readonly QueueConsumer[],
  batch: MessageBatch<unknown>,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  const consumer = consumers.find((c) => matchesQueue(c.queue, batch.queue));
  if (!consumer) {
    // ⚠ 握りつぶすとメッセージが黙って消える。再試行させるために投げる。
    throw new Error(`queue "${batch.queue}" の consumer がありません`);
  }
  await consumer.handle(batch, env, ctx);
}
