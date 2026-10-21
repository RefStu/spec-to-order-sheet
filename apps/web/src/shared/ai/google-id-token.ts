import type { Bindings } from "../hono";

/**
 * Cloud Run (ai) を呼ぶための ID token を作る。
 *
 * デプロイ先とローカルで **同じコード** を使う。違うのは `GOOGLE_TOKEN_URL` と鍵だけ:
 *   - デプロイ先: https://oauth2.googleapis.com/token + 実際の invoker SA の鍵
 *   - ローカル:   gcp-emulator の /token + make keys が作るダミー鍵
 *
 * ⚠ **node:crypto も jsonwebtoken も使えない。** Workers ランタイムには無い。
 *   RS256 の署名は WebCrypto (crypto.subtle) で行う。
 * ⚠ Buffer も無いので、base64 は atob / btoa で扱う。
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface CachedToken {
  token: string;
  /** epoch 秒。 */
  expiresAt: number;
}

// ⚠ isolate ごとのキャッシュ。リクエストをまたいで残るが、消えても取り直すだけなので害は無い。
const cache = new Map<string, CachedToken>();

/** 期限のこれだけ手前で取り直す (時計のずれと往復の時間ぶん)。 */
const REFRESH_MARGIN_SEC = 60;
const TOKEN_TTL_SEC = 3600;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  // ⚠ String.fromCharCode(...bytes) は大きい鍵でスタックを溢れさせる。1 バイトずつ足す。
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8ToBase64Url(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

/** PEM (PKCS#8) を WebCrypto が読める ArrayBuffer にする。 */
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signRs256(payload: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(payload),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI_INVOKER_SA_KEY が JSON として読めません");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error("AI_INVOKER_SA_KEY に client_email / private_key がありません");
  }
  // ⚠ .env に 1 行で入っているので、改行が \n のままのことがある。
  return { client_email: key.client_email, private_key: key.private_key.replace(/\\n/g, "\n") };
}

/**
 * `audience` (= Cloud Run のサービス URL) 向けの ID token を返す。
 *
 * 手順は Google の「JWT bearer による ID token の取得」そのまま:
 *   1. SA の鍵で RS256 の JWT (assertion) を作る
 *   2. token endpoint に grant_type=jwt-bearer で送る
 *   3. 返ってきた id_token を使う
 */
export async function getIdToken(
  env: Pick<Bindings, "AI_INVOKER_SA_KEY" | "GOOGLE_TOKEN_URL">,
  audience: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get(audience);
  if (cached && cached.expiresAt - REFRESH_MARGIN_SEC > now) return cached.token;

  const key = parseServiceAccountKey(env.AI_INVOKER_SA_KEY);
  const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = utf8ToBase64Url(
    JSON.stringify({
      iss: key.client_email,
      sub: key.client_email,
      aud: env.GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + TOKEN_TTL_SEC,
      // ⚠ これが ID token の aud になる。Cloud Run 側の検証と一致させること。
      target_audience: audience,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const assertion = `${signingInput}.${await signRs256(signingInput, key.private_key)}`;

  const res = await fetch(env.GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`ID token を取得できません: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id_token?: string; expires_in?: number };
  if (!body.id_token) throw new Error("token endpoint の応答に id_token がありません");

  cache.set(audience, {
    token: body.id_token,
    expiresAt: now + (body.expires_in ?? TOKEN_TTL_SEC),
  });
  return body.id_token;
}

/** テスト用: キャッシュを捨てる。 */
export function resetIdTokenCacheForTest(): void {
  cache.clear();
}
