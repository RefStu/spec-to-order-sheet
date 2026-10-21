import { base64UrlToBytes, base64UrlToString } from "./base64url";

/**
 * GIP の ID トークン (JWT) を Workers で検証する。
 *
 * 標準の 4 つに、tenant を足した 5 つを確かめる。
 *   1. 署名 (RS256)          … WebCrypto。node:crypto も jsonwebtoken も Workers には無い
 *   2. iss                   … https://securetoken.google.com/<projectId>
 *   3. aud                   … <projectId>
 *   4. exp                   … 期限切れでないこと
 *   5. firebase.tenant       … 設定した tenant (GIP_TENANT_ID) と一致すること
 *
 * ⚠⚠ **tenant は iss / aud に出てこない。** 同じ GCP プロジェクトの別 tenant の
 *   トークンも iss と aud は同じなので、それだけ見ると別の tenant の利用者が通ってしまう。
 *   tenant の無いトークン (project 直下の利用者) も、tenant を設定しているときは落とす (逆も同じ)。
 *
 * ⚠ **公開鍵を毎リクエストで取りに行かない。** 取ってきた JWKS を Cache API に
 *   提供元の max-age に合わせて置く。
 * ⚠ Workers には Google の秘密鍵を置かない。持つのはプロジェクト ID だけ。
 */

/**
 * GIP (Secure Token Service) が ID token の署名に使う鍵の JWKS。
 *
 * ⚠⚠ **パスは `/jwk/` (単数形)。`/jwks/` は 404 を返す。**
 *   単体テストは fetchJwks を差し替えるので、ここを間違えても**テストでは気付けない**
 *   (実際に間違えたまま通っていて、実機で初めて出た)。
 *   綴りを固定するテストを verify.test.ts に置いてある。
 */
export const GIP_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** Cache API のキーは URL でなければならないので、内部用の URL を 1 つ決めておく。 */
const JWKS_CACHE_KEY = "https://spec-to-order-sheet.invalid/__jwks/securetoken";

const DEFAULT_JWKS_TTL_SECONDS = 3600;

export interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time?: number;
  /** tenant の利用者なら firebase.tenant に tenant ID が入る。project 直下なら無い。 */
  firebase?: { tenant?: string };
}

export type VerifyFailure =
  | "malformed"
  | "unsupported_alg"
  | "unknown_key"
  | "bad_signature"
  | "bad_issuer"
  | "bad_audience"
  | "expired"
  | "bad_tenant";

export type VerifyResult =
  { ok: true; claims: IdTokenClaims } | { ok: false; reason: VerifyFailure };

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

/** JWKS の取得。差し替えられるように関数で受け取る (テスト用)。 */
export type JwksFetcher = () => Promise<{ keys: Jwk[]; ttlSeconds: number }>;

function parseMaxAge(cacheControl: string | null): number {
  const match = cacheControl?.match(/max-age=(\d+)/);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_JWKS_TTL_SECONDS;
}

/**
 * JWKS を Cache API 越しに取る。
 * ⚠ caches.default が無い実行環境 (node のテスト) では素の fetch に落ちる。
 */
export const fetchGipJwks: JwksFetcher = async () => {
  const cache = typeof caches !== "undefined" ? await caches.open("gip-jwks") : undefined;
  const cached = await cache?.match(JWKS_CACHE_KEY);
  if (cached) return { keys: ((await cached.json()) as { keys: Jwk[] }).keys, ttlSeconds: 0 };

  const res = await fetch(GIP_JWKS_URL);
  if (!res.ok) throw new Error(`JWKS の取得に失敗しました: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const ttlSeconds = parseMaxAge(res.headers.get("cache-control"));

  await cache?.put(
    JWKS_CACHE_KEY,
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` },
    }),
  );
  return { keys: body.keys, ttlSeconds };
};

function decodeSegment<T>(segment: string | undefined): T | undefined {
  if (!segment) return undefined;
  try {
    return JSON.parse(base64UrlToString(segment)) as T;
  } catch {
    return undefined;
  }
}

/**
 * ID トークンを検証する。
 *
 * ⚠ 失敗の理由は**呼び出し側の中だけで使う**。画面にも API の返り値にも出さない
 *   (どこが違うかを教えると当てられる)。
 */
export async function verifyIdToken(
  token: string,
  projectId: string,
  options: { now?: number; fetchJwks?: JwksFetcher; tenantId?: string } = {},
): Promise<VerifyResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const fetchJwks = options.fetchJwks ?? fetchGipJwks;

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeSegment<{ alg?: string; kid?: string }>(headerPart);
  const claims = decodeSegment<IdTokenClaims>(payloadPart);
  if (!header || !claims) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };

  const { keys } = await fetchJwks();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown_key" };

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const signature = base64UrlToBytes(signaturePart);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) return { ok: false, reason: "bad_signature" };

  if (claims.iss !== `https://securetoken.google.com/${projectId}`) {
    return { ok: false, reason: "bad_issuer" };
  }
  if (claims.aud !== projectId) return { ok: false, reason: "bad_audience" };
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return { ok: false, reason: "expired" };
  // ⚠ 空どうしの一致も「一致」とする (tenant を設定していないとき)。
  if ((claims.firebase?.tenant ?? "") !== (options.tenantId ?? "").trim()) {
    return { ok: false, reason: "bad_tenant" };
  }

  return { ok: true, claims };
}
