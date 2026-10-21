// ⚠ **undici のメジャーを @types/node の undici-types に合わせること** (いまは 6 系)。
//   ずらすと `RequestInit.dispatcher` の型が合わず typecheck が落ちる。
//   ⚠ ここは `node:` を使ってよい (禁止は apps/web/src だけ)。
import { Agent } from "undici";

/**
 * ai (Cloud Run 相当) への転送。
 *
 * ⚠ **stream をそのまま返す。** 本文を読むと chat も workflow の進捗もまとめて最後に届く。
 * ⚠ **content-encoding / content-length を落とす。** node の fetch (undici) は本文を
 *   展開済みなのにヘッダを残すので、そのまま返すとブラウザが壊れた gzip として扱う
 *   (apps/web の relayStream() が落としているのと同じ理由)。長さは node-server に決めさせる。
 * ⚠ **リクエストの本文は読み切ってから渡す。** web → ai は必ず小さい JSON なので、
 *   これで undici の `duplex: "half"` (TS の RequestInit に無い) が要らなくなる。
 * ⚠⚠ **node の fetch は 300 秒でヘッダを待つのをやめる** (undici の `headersTimeout` の既定)。
 *   帳票の読み取りは分類 + 発注書 + 依頼書の枚数ぶんで**軽く 300 秒を超える**ので、
 *   そのままだと `UND_ERR_HEADERS_TIMEOUT` になり、**ai が仕事を終えていても web には
 *   502 が返る** (実測: 301 秒で "fetch failed"。ジョブは再試行に回り、時間だけが捨てられる)。
 *   → 下の `LONG_RUNNING` で時間の上限を外す。**Cloud Run 側の `timeout` と同じ話**で、
 *   短いほうで切れる (`apps/ai/src/shared/server.ts` の注記も参照)。
 */

/** 転送してはいけないヘッダ。authorization は IAM の検証でここが使い切る。 */
const DROP_REQUEST_HEADERS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "host",
  "authorization",
  "content-length",
];

const DROP_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "content-encoding",
  "content-length",
];

function filterHeaders(source: Headers, drop: string[]): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!drop.includes(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * 時間の上限を外した dispatcher。**転送にだけ使う。**
 *
 * ⚠ `headersTimeout` は「応答のヘッダが来るまで」、`bodyTimeout` は「本文の次の塊が来るまで」。
 *   どちらも既定 300 秒。0 で無効。
 * ⚠ **本番には影響しない。** ここはローカルの Cloud Run の代わりで、本番では
 *   Cloudflare Workers の fetch が web → Cloud Run を直接つなぐ。
 */
const LONG_RUNNING = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** 既定の転送。**`dispatcher` は undici の拡張**なので RequestInit には無い。 */
const longRunningFetch: FetchLike = (input, init) =>
  (globalThis.fetch as (i: string, o: RequestInit & { dispatcher?: Agent }) => Promise<Response>)(
    input,
    { ...init, dispatcher: LONG_RUNNING },
  );

export async function proxyRequest(
  request: Request,
  upstreamBase: string,
  fetchImpl: FetchLike = longRunningFetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `${upstreamBase}${incoming.pathname}${incoming.search}`;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers: filterHeaders(request.headers, DROP_REQUEST_HEADERS),
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch (e) {
    // ⚠ **`cause` まで出す。** undici は本当の理由 (UND_ERR_HEADERS_TIMEOUT など) を
    //   `cause` に入れ、`message` は "fetch failed" しか言わない。落として原因を隠さないこと。
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return Response.json(
      {
        error: {
          code: 502,
          message:
            `ai (${upstreamBase}) に繋がりません: ${(e as Error).message}` +
            `${detail ? ` (${detail})` : ""}\n` +
            `make dev で ai が起動しているか確認してください。`,
          status: "UNAVAILABLE",
        },
      },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: filterHeaders(upstream.headers, DROP_RESPONSE_HEADERS),
  });
}
