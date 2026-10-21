/**
 * gcp-emulator の検査。
 *
 * ⚠ **web 側と同じ手順で assertion を作る**のが要点。正は
 *   apps/web/src/shared/ai/google-id-token.ts で、あちらは WebCrypto、ここは node:crypto。
 *   片方だけ直しても気付けないので、claims の形はここで固定する。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmulatorApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { EmulatorKeys } from "./keys.ts";
import { decodeJwt, signJwt } from "./jwt.ts";

const TOKEN_URL = "http://127.0.0.1:4010/token";
const AUDIENCE = "http://127.0.0.1:4010";
const UPSTREAM = "http://127.0.0.1:4011";
const SA_EMAIL = "ai-invoker-local@test.iam.gserviceaccount.com";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

const sa = keyPair();
const google = keyPair();
const other = keyPair();

const keys: EmulatorKeys = {
  sa: {
    clientEmail: SA_EMAIL,
    clientId: "123456789012345678901",
    kid: "sa-kid",
    publicKey: createPublicKey(sa.publicPem),
  },
  google: {
    kid: "google-kid",
    privateKey: createPrivateKey(google.privatePem),
    publicKey: createPublicKey(google.publicPem),
    jwk: createPublicKey(google.publicPem).export({ format: "jwk" }) as Record<string, unknown>,
  },
};

const config = loadConfig({
  PORT: "4010",
  AI_UPSTREAM_URL: UPSTREAM,
  TOKEN_URL,
  EXPECTED_AUDIENCE: AUDIENCE,
});

let fetchImpl: ReturnType<typeof vi.fn>;

function makeApp() {
  return createEmulatorApp({ config, loadKeys: () => keys, fetchImpl: fetchImpl as never });
}

/** apps/web の getIdToken() が作る assertion と同じ形。 */
function assertion(overrides: Record<string, unknown> = {}, privatePem = sa.privatePem) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: "RS256", typ: "JWT" }, // ⚠ web は kid を付けない
    {
      iss: SA_EMAIL,
      sub: SA_EMAIL,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
      target_audience: AUDIENCE,
      ...overrides,
    },
    createPrivateKey(privatePem),
  );
}

/** res.json() は unknown を返すので、期待する形を書いて取り出す。 */
async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function tokenRequest(body: Record<string, string>) {
  return new Request(`${AUDIENCE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

async function mintIdToken(overrides: Record<string, unknown> = {}) {
  const res = await makeApp().request(
    tokenRequest({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: assertion(overrides),
    }),
  );
  const body = (await res.json()) as { id_token: string };
  return body.id_token;
}

beforeEach(() => {
  fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
});

describe("POST /token", () => {
  it("web が作る assertion を受け取り、target_audience 向けの ID token を返す", async () => {
    const res = await makeApp().request(
      tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id_token: string; expires_in: number };
    expect(body.expires_in).toBe(3600);

    const decoded = decodeJwt(body.id_token);
    expect(decoded.claims.aud).toBe(AUDIENCE);
    expect(decoded.claims.email).toBe(SA_EMAIL);
    expect(decoded.claims.email_verified).toBe(true);
    expect(decoded.claims.iss).toBe("https://accounts.google.com");
    expect(decoded.header.kid).toBe("google-kid");
  });

  it("grant_type が違えば 400", async () => {
    const res = await makeApp().request(
      tokenRequest({ grant_type: "client_credentials", assertion: assertion() }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("unsupported_grant_type");
  });

  it("別の鍵で署名した assertion は 400 (署名が合わない)", async () => {
    const res = await makeApp().request(
      tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion({}, other.privatePem),
      }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error_description: string }>(res)).error_description).toContain(
      "Signature",
    );
  });

  it("aud が GOOGLE_TOKEN_URL でなければ 400 で期待値を示す", async () => {
    const res = await makeApp().request(
      tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion({ aud: "https://oauth2.googleapis.com/token" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error_description: string }>(res)).error_description).toContain(
      TOKEN_URL,
    );
  });

  it("iss が invoker SA でなければ 400", async () => {
    const res = await makeApp().request(
      tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion({ iss: "someone@else.com" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("期限切れの assertion は 400", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const res = await makeApp().request(
      tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion({ iat: past, exp: past + 3600 }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error_description: string }>(res)).error_description).toContain(
      "有効期限",
    );
  });
});

describe("GET /jwks", () => {
  it("ID token の署名鍵を JWK Set で出す", async () => {
    const res = await makeApp().request("/jwks");
    const body = (await res.json()) as { keys: { kty: string; kid: string; alg: string }[] };
    expect(body.keys[0]?.kty).toBe("RSA");
    expect(body.keys[0]?.kid).toBe("google-kid");
    expect(body.keys[0]?.alg).toBe("RS256");
  });
});

describe("catch-all (Cloud Run IAM の再現)", () => {
  async function callAi(headers: Record<string, string> = {}) {
    return makeApp().request(`${AUDIENCE}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ messages: [] }),
    });
  }

  it("token が無ければ 401", async () => {
    const res = await callAi();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("壊れた token は 401", async () => {
    expect((await callAi({ authorization: "Bearer bogus" })).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("別の鍵で署名した ID token は 401", async () => {
    const forged = signJwt(
      { alg: "RS256", typ: "JWT" },
      {
        aud: AUDIENCE,
        email: SA_EMAIL,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      createPrivateKey(other.privatePem),
    );
    expect((await callAi({ authorization: `Bearer ${forged}` })).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aud が違う token は 403 (署名は正しい)", async () => {
    const idToken = await mintIdToken({ target_audience: "https://elsewhere.example" });
    const res = await callAi({ authorization: `Bearer ${idToken}` });
    expect(res.status).toBe(403);
    expect((await jsonOf<{ error: { message: string } }>(res)).error.message).toContain(AUDIENCE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("invoker SA でない email の token は 403", async () => {
    const notInvoker = signJwt(
      { alg: "RS256", typ: "JWT" },
      {
        aud: AUDIENCE,
        email: "someone@else.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      keys.google.privateKey,
    );
    const res = await callAi({ authorization: `Bearer ${notInvoker}` });
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("正しい token なら ai へ転送する (authorization と host は落とす)", async () => {
    const idToken = await mintIdToken();
    const res = await callAi({ authorization: `Bearer ${idToken}` });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${UPSTREAM}/v1/chat`);
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("ai が落ちていれば 502 で次の一手を示す", async () => {
    fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const idToken = await mintIdToken();
    const res = await callAi({ authorization: `Bearer ${idToken}` });
    expect(res.status).toBe(502);
    expect((await jsonOf<{ error: { message: string } }>(res)).error.message).toContain("make dev");
  });
});
