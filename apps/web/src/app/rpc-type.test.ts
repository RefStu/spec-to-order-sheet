import type { InferRequestType, InferResponseType } from "hono/client";
import { hc } from "hono/client";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../shared/hono";
import { stringToBase64Url } from "../shared/auth/base64url";
import { DEV_TOKEN_PREFIX } from "../shared/auth/dev-token";
import type { AppType } from "./routes.gen";
import { featureApi } from "./routes.gen";

/**
 * app/routes.gen.ts が feature を連結しても **Hono RPC の型が落ちないこと** を確かめる。
 *
 * ⚠ ここが壊れても実行時エラーにはならない。`AppType` が `any` に潰れると、
 *   hc の呼び出しは何を書いても通ってしまい、型安全が黙って失われる。
 *   そのため「any ではないこと」を型レベルで検査する。
 * ⚠ 見本にする feature は **PoC が終わっても残るもの** にする (試作用の
 *   サンプル feature を指していると、それを消したときにこの検査ごと消える)。
 *   order-sheets は GET / PATCH(json) / POST(:param) が揃っているので都合がよい。
 */

type IsAny<T> = 0 extends 1 & T ? true : false;
type Expect<T extends true> = T;

// ⚠ base は絶対 URL。相対パスだと $url() が "Invalid URL" で落ちる。
const client = hc<AppType>("http://web.test");
// ⚠ feature 名にハイフンが入るのでブラケットで引く。
const orderSheets = client.api["order-sheets"];

// --- 型の検査 (tsc が通ることが検査そのもの) -------------------------------------
type _RouteIsNotAny = Expect<
  IsAny<(typeof orderSheets)[":caseId"]["$get"]> extends true ? false : true
>;
type _AppTypeIsNotAny = Expect<IsAny<AppType> extends true ? false : true>;

/**
 * 応答が「欄」の形として推論される。
 * ⚠ ヘッダも明細も **セルの番地をキーにした partialRecord**。
 * ⚠ どの欄が AI かは filledBy だけが答える。
 */
type OrderSheetResponse = InferResponseType<(typeof orderSheets)[":caseId"]["$get"]>;
type _HasHeaderFields = Expect<
  OrderSheetResponse extends { header: Record<string, unknown> } ? true : false
>;
type _HasFilledBy = Expect<
  NonNullable<OrderSheetResponse["header"]["A12"]> extends { filledBy: unknown } ? true : false
>;

/** path param と json body が型で要求される。 */
type PatchRequest = InferRequestType<(typeof orderSheets)[":caseId"]["$patch"]>;
type _PatchNeedsParam = Expect<PatchRequest extends { param: { caseId: string } } ? true : false>;
type _PatchNeedsJson = Expect<PatchRequest extends { json: unknown } ? true : false>;

describe("app/routes.gen.ts", () => {
  it("feature の API が /api/<name> にマウントされている", () => {
    const routes = featureApi.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain("POST /api/files/uploads");
    expect(routes).toContain("GET /api/order-sheets/:caseId");
    expect(routes).toContain("PATCH /api/order-sheets/:caseId");
    expect(routes).toContain("POST /api/order-sheets/:caseId/approve");
  });

  it("hc が組み立てる URL が実際のパスと一致する", () => {
    expect(orderSheets[":caseId"].$url({ param: { caseId: "c1" } }).pathname).toBe(
      "/api/order-sheets/c1",
    );
    expect(orderSheets[":caseId"].approve.$url({ param: { caseId: "c1" } }).pathname).toBe(
      "/api/order-sheets/c1/approve",
    );
  });

  // ⚠ authMiddleware は createApp() が共通で付けるので、root でも走る。
  //   ここから下は「認証を通したあとに 404 になる」ことを確かめる。
  it("トークンが無ければ 401 (どのパスが在るかを漏らさない)", async () => {
    const res = await featureApi.request("/api/not-a-feature", undefined, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("認証を通せば、登録していないパスは 404", async () => {
    const res = await featureApi.request(
      "/api/not-a-feature",
      { headers: authHeaders() },
      fakeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/auth/config は認証なしで通る (ブラウザが最初に読む設定)", async () => {
    const res = await featureApi.request("/api/auth/config", undefined, fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ projectId: "", devBypass: true });
  });
});

/** GIP 未設定 + 代替サインイン有効 の Bindings。 */
function fakeEnv(): Bindings {
  return {
    GIP_PROJECT_ID: "",
    GIP_AUTH_DOMAIN: "",
    AUTH_DEV_BYPASS: "1",
  } as unknown as Bindings;
}

function authHeaders(): Record<string, string> {
  const payload = JSON.stringify({
    sub: "dev-1",
    email: "tester@example.invalid",
    name: "テスト",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { Authorization: `Bearer ${DEV_TOKEN_PREFIX}${stringToBase64Url(payload)}` };
}
