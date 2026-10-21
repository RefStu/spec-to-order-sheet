import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import type { Bindings } from "./hono";
import { defineQueueConsumer, dispatchQueue, matchesQueue } from "./queue";

function batch(queue: string): MessageBatch<unknown> {
  return {
    queue,
    messages: [],
    retryAll: () => {},
    ackAll: () => {},
  } as unknown as MessageBatch<unknown>;
}

const env = {} as Bindings;
const ctx = {} as ExecutionContext;

describe("matchesQueue", () => {
  it("同じ名前に一致する", () => {
    expect(matchesQueue("app-jobs", "app-jobs")).toBe(true);
  });

  // ⚠ ここが startsWith だと、別の queue のメッセージを取り違えて処理してしまう。
  it("接尾辞つきの名前には一致しない", () => {
    expect(matchesQueue("app-jobs", "app-jobs-archive")).toBe(false);
    expect(matchesQueue("app-jobs", "app-jobs-dlq")).toBe(false);
    expect(matchesQueue("app-jobs", "app-jobs-dev")).toBe(false);
    expect(matchesQueue("app-jobs", "other-jobs")).toBe(false);
  });
});

describe("dispatchQueue", () => {
  it("queue 名が一致する consumer に届く", async () => {
    const handle = vi.fn(async () => {});
    const consumer = defineQueueConsumer({ queue: "app-jobs", handle });
    await dispatchQueue([consumer], batch("app-jobs"), env, ctx);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("対応する consumer が無ければ投げる (握りつぶさない)", async () => {
    const consumer = defineQueueConsumer({ queue: "app-jobs", handle: async () => {} });
    await expect(dispatchQueue([consumer], batch("app-other"), env, ctx)).rejects.toThrow(
      /app-other/,
    );
  });
});
