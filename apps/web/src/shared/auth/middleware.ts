import type { MiddlewareHandler } from "hono";
import type { HonoEnv } from "../hono";
import { parseDevToken } from "./dev-token";
import { isPublicApiPath } from "./routes";
import { verifyIdToken } from "./verify";

export interface AuthUser {
  uid: string;
  email: string;
  name: string;
  /** どの経路で通ったか。dev はローカル専用の代替サインイン。 */
  via: "gip" | "dev";
}

/**
 * /api/* に入る前に ID トークンを検証する。
 *
 * ⚠ **root (app/routes.gen.ts) と各 feature の sub-app の両方で走る。**
 *   createApp() が共通で付けるため。2 度目は c.get("auth") を見て素通りするので、
 *   検証は 1 リクエストにつき 1 回だけ。
 * ⚠ 失敗の理由を返り値に出さない。401 と "unauthorized" だけを返す。
 */
export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const { pathname } = new URL(c.req.url);

  // API 以外 (SPA のアセット) は素通り。デプロイ先では run_worker_first で /api/* しか来ない。
  if (!pathname.startsWith("/api/")) return next();
  if (isPublicApiPath(pathname)) return next();
  // 2 度目の呼び出し。
  if (c.get("auth")) return next();

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const user = await authenticate(token, c.env);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  c.set("auth", user);
  return next();
};

/**
 * トークンから利用者を決める。
 *
 * ⚠ **代替サインインが効くのは「GIP が未設定」かつ「AUTH_DEV_BYPASS=1」のときだけ。**
 *   GIP_PROJECT_ID が入った瞬間に代替は死に、本物の検証しか通らなくなる。
 */
export async function authenticate(
  token: string,
  env: { GIP_PROJECT_ID: string; GIP_TENANT_ID?: string; AUTH_DEV_BYPASS?: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<AuthUser | undefined> {
  const projectId = (env.GIP_PROJECT_ID ?? "").trim();

  if (!projectId) {
    if (env.AUTH_DEV_BYPASS !== "1") return undefined;
    const payload = parseDevToken(token, now);
    if (!payload) return undefined;
    return { uid: payload.sub, email: payload.email, name: payload.name, via: "dev" };
  }

  // ⚠ tenant は設定したものだけを通す (verify.ts の 5.)。
  const result = await verifyIdToken(token, projectId, { now, tenantId: env.GIP_TENANT_ID });
  if (!result.ok) return undefined;
  const { claims } = result;
  return {
    uid: claims.sub,
    email: claims.email ?? "",
    name: claims.name ?? claims.email ?? "",
    via: "gip",
  };
}
