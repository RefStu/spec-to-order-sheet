/**
 * GIP のサインイン。**Identity Toolkit の REST を直接叩く。**
 *
 * firebase の Web SDK は入れていない。使うのは fetch だけ。
 *
 * ⚠⚠ **サインインは GIP_TENANT_ID の tenant に対して行う。** tenantId を付けないと
 *   project 直下の利用者を探しに行く (そこには誰もいないので、正しいパスワードでも必ず失敗する)。
 *   refresh (securetoken) はトークンが tenant を持っているので、tenantId は要らない。
 * ⚠ **失敗の理由をここから外へ出さない。** 画面には
 *   「メールアドレスかパスワードが違います」だけを出す。
 *   EMAIL_NOT_FOUND / INVALID_PASSWORD の区別が漏れると、そこから当てられる。
 */

const SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const REFRESH_URL = "https://securetoken.googleapis.com/v1/token";

export interface SignInResult {
  idToken: string;
  refreshToken: string;
  /** ID トークンが切れる時刻 (epoch 秒)。 */
  expiresAt: number;
  email: string;
  displayName: string;
  localId: string;
}

function expiresAtFrom(expiresIn: string | undefined): number {
  const seconds = Number(expiresIn);
  return Math.floor(Date.now() / 1000) + (Number.isFinite(seconds) ? seconds : 3600);
}

export async function signInWithPassword(
  apiKey: string,
  email: string,
  password: string,
  tenantId?: string,
): Promise<SignInResult | undefined> {
  const res = await fetch(`${SIGN_IN_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
      ...(tenantId ? { tenantId } : {}),
    }),
  });
  // ⚠ res.json() の error.message は見ない。どちらが違うかを知る手段を作らない。
  if (!res.ok) return undefined;

  const body = (await res.json()) as {
    idToken: string;
    refreshToken: string;
    expiresIn: string;
    email: string;
    displayName?: string;
    localId: string;
  };
  return {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresAt: expiresAtFrom(body.expiresIn),
    email: body.email,
    displayName: body.displayName ?? body.email,
    localId: body.localId,
  };
}

export interface RefreshResult {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function refreshIdToken(
  apiKey: string,
  refreshToken: string,
): Promise<RefreshResult | undefined> {
  const res = await fetch(`${REFRESH_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) return undefined;

  const body = (await res.json()) as {
    id_token: string;
    refresh_token: string;
    expires_in: string;
  };
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: expiresAtFrom(body.expires_in),
  };
}
