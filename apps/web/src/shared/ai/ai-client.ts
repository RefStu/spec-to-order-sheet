import { loadEnv, webEnvSchema } from "@repo/shared/env";
import type { Bindings } from "../hono";
import { getIdToken } from "./google-id-token";

/**
 * Cloud Run (ai) を呼ぶ。
 *
 * ⚠ **stream をそのまま返す。** 本文を読んでしまうと chat / workflow の進捗が
 *   まとめて最後に届くようになる。Response の body を触らずに中継すること。
 * ⚠ env は **呼ばれたときに** 検証する (import 時ではない)。`.dev.vars` をまだ用意していないと
 *   ここで EnvError になるが、D1 / Queue だけを使う機能は、ここを通らないので影響を受けない。
 */
function aiEnv(env: Bindings) {
  return loadEnv(webEnvSchema, env as unknown as Record<string, unknown>);
}

export interface FetchAiOptions {
  /** ai 側のパス。正は apps/ai/src/features/<name>/contract.ts。 */
  path: string;
  body: unknown;
  signal?: AbortSignal;
}

export async function fetchAi(env: Bindings, options: FetchAiOptions): Promise<Response> {
  const { AI_BASE_URL, GOOGLE_TOKEN_URL, AI_INVOKER_SA_KEY } = aiEnv(env);
  const idToken = await getIdToken({ AI_INVOKER_SA_KEY, GOOGLE_TOKEN_URL }, AI_BASE_URL);

  return fetch(new URL(options.path, AI_BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(options.body),
    signal: options.signal,
  });
}

/**
 * ai の stream をブラウザへそのまま中継する。
 *
 * ⚠ content-encoding / content-length は転送の途中で変わるので落とす。
 *   残すと「壊れた gzip」としてブラウザに解釈される。
 */
export function relayStream(upstream: Response): Response {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  // SSE が途中のプロキシで固まらないようにする。
  headers.set("x-accel-buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}
