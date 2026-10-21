/**
 * 転送の検査。**stream が stream のまま返ること**が一番大事
 * (ここが崩れると chat も workflow の進捗もまとめて最後に届く)。
 */
import { describe, expect, it, vi } from "vitest";
import { type FetchLike, proxyRequest } from "./proxy.ts";

const UPSTREAM = "http://127.0.0.1:4011";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      // ⚠ undici は本文を展開済みなのにこのヘッダを残す。落とさないとブラウザが壊れた gzip として扱う。
      "content-encoding": "gzip",
      "content-length": "999",
    },
  });
}

describe("proxyRequest", () => {
  it("SSE を 1 つずつ流したまま返し、content-encoding / content-length を落とす", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => sseResponse(["data: a\n\n", "data: b\n\n"]));
    const res = await proxyRequest(
      new Request(`${UPSTREAM}/v1/chat`, { method: "POST", body: "{}" }),
      UPSTREAM,
      fetchImpl,
    );

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();

    // ⚠ 本文をまとめて読むのではなく、分けて届くことを確かめる。
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const received: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(decoder.decode(value));
    }
    expect(received).toEqual(["data: a\n\n", "data: b\n\n"]);
  });

  it("path と query をそのまま引き継ぐ", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("ok"));
    await proxyRequest(
      new Request(`${UPSTREAM}/v1/jobs/abc/run?x=1`, { method: "POST", body: "{}" }),
      UPSTREAM,
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${UPSTREAM}/v1/jobs/abc/run?x=1`);
  });

  it("GET は本文を付けない", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("ok"));
    await proxyRequest(new Request(`${UPSTREAM}/`), UPSTREAM, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1].body).toBeUndefined();
  });

  /**
   * ⚠⚠ **undici は本当の理由を `cause` に入れる。** `message` は "fetch failed" しか
   *   言わないので、落とすと「なぜ繋がらないのか」が消える。
   *   実測で `UND_ERR_HEADERS_TIMEOUT` (300 秒) をこれで見逃し、ai が仕事を終えていたのに
   *   502 として捨てていた。
   */
  it("繋がらないときは cause まで出す (fetch failed だけにしない)", async () => {
    const error = new TypeError("fetch failed");
    (error as Error & { cause?: unknown }).cause = { code: "UND_ERR_HEADERS_TIMEOUT" };
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw error;
    });

    const res = await proxyRequest(
      new Request(`${UPSTREAM}/v1/doc-extract/document`, { method: "POST", body: "{}" }),
      UPSTREAM,
      fetchImpl,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("fetch failed");
    expect(body.error.message).toContain("UND_ERR_HEADERS_TIMEOUT");
  });
});
