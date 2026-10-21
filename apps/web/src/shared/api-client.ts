import { QueryClient } from "@tanstack/react-query";
import { hc } from "hono/client";
import type { AppType } from "../app/routes.gen";
import { AUTH_SIGNED_OUT_EVENT, clearSession, currentIdToken } from "./auth/token-store";

/**
 * 型付きの API クライアント (Hono RPC)。
 *
 * ⚠ **base に "/" のような相対パスを渡さない。** hc の `$url()` / `$ws()` は
 *   `new URL(base + path)` を作るので、絶対 URL でないと "Invalid URL" で落ちる
 *   (`$get()` だけは fetch が相対 URL を受け付けるので、気付くのが遅れる)。
 * ⚠ `AppType` は app/routes.gen.ts の生成物。**型だけ** を読む
 *   (値を読むと境界ルールで落ちる: shared は entry のコードを持てない)。
 * ⚠ **cookie を使わない。** ID トークンは Authorization: Bearer ヘッダで送る。
 *   ローカルで port 違いの環境を並べると、cookie は port を区別しないので混ざるため。
 */
const baseUrl = typeof location === "undefined" ? "http://localhost" : location.origin;

/**
 * ID トークンを載せる fetch。401 が返ったらサインアウトさせる。
 *
 * ⚠ **hc を通らない呼び出しは必ずこれを使う。** 素の fetch を使うと Authorization が
 *   付かず 401 になる。別 feature の API (order-sheets / files /
 *   purchase-orders) は RPC 型を跨げないので素の fetch になる — そこで使う。
 */
export const apiFetch: typeof fetch = async (input, init) => {
  const token = currentIdToken();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 && token) {
    // トークンが切れている / 失効している。AuthProvider に伝えてログイン画面へ戻す。
    clearSession();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTH_SIGNED_OUT_EVENT));
    }
  }
  return res;
};

export const apiClient = hc<AppType>(baseUrl, { fetch: apiFetch });

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 画面を切り替えるたびに取り直さない。更新は mutation の invalidate で行う。
      staleTime: 30_000,
      retry: 1,
    },
  },
});
