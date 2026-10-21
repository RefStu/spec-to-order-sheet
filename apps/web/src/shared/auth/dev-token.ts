import { base64UrlToString } from "./base64url";

/**
 * ⚠⚠ **ローカル専用の代替サインイン。**
 *
 * GIP を用意しなくてもローカルで画面と API を動かすためだけのもの。
 * **署名が無いので、これをデプロイ先で受け付けると無認証と同じ。**
 *
 * 安全弁は 2 枚:
 *   1. AUTH_DEV_BYPASS はローカルの `.dev.vars` にだけ置く … デプロイ先には配らない
 *   2. middleware が GIP_PROJECT_ID の空も確かめる … GIP を設定した瞬間に無効になる
 *
 * どちらも外さないこと (テスト: auth/middleware.test.ts)。
 */
export const DEV_TOKEN_PREFIX = "dev.";

export interface DevTokenPayload {
  sub: string;
  email: string;
  name: string;
  exp: number;
}

export function parseDevToken(token: string, now: number): DevTokenPayload | undefined {
  if (!token.startsWith(DEV_TOKEN_PREFIX)) return undefined;
  try {
    const payload = JSON.parse(
      base64UrlToString(token.slice(DEV_TOKEN_PREFIX.length)),
    ) as DevTokenPayload;
    if (!payload.sub || !payload.email) return undefined;
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
