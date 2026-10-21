import { beforeAll, describe, expect, it } from "vitest";
import { GIP_JWKS_URL, verifyIdToken, type IdTokenClaims } from "./verify";

/**
 * 4 つ (署名 / iss / aud / exp) と tenant の照合を固定する。
 * ⚠ 鍵はテストの中で作る。リポジトリに鍵を置かない。
 */

const PROJECT_ID = "example-poc-project";
const NOW = 1_700_000_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // ⚠ String.fromCharCode(...bytes) は長い配列でスタックを溢れさせるので 1 バイトずつ。
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

let keyPair: CryptoKeyPair;
let jwk: { kid: string; kty: string; n: string; e: string };
let otherPair: CryptoKeyPair;

const fetchJwks = async () => ({ keys: [jwk], ttlSeconds: 3600 });

async function sign(
  claims: Partial<IdTokenClaims>,
  opts: { kid?: string; alg?: string; key?: CryptoKey } = {},
): Promise<string> {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? jwk.kid, typ: "JWT" };
  const payload: IdTokenClaims = {
    sub: "user-1",
    email: "tester@example.invalid",
    name: "テスト太郎",
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    iat: NOW - 60,
    exp: NOW + 3600,
    ...claims,
  };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    opts.key ?? keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

beforeAll(async () => {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  } as const;
  keyPair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  otherPair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const exported = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as {
    kty: string;
    n: string;
    e: string;
  };
  jwk = { kid: "test-key-1", kty: exported.kty, n: exported.n, e: exported.e };
});

describe("GIP_JWKS_URL", () => {
  // ⚠ 下のテストはすべて fetchJwks を差し替えるので、**実 URL の綴りは試していない**。
  //   実際に /jwks/ (複数形) と書いて 404 になり、実機で初めて出た。ここで綴りを固定する。
  it("パスは /service_accounts/v1/jwk/ (単数形)", () => {
    expect(GIP_JWKS_URL).toBe(
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    );
    expect(GIP_JWKS_URL).not.toContain("/jwks/");
  });
});

describe("verifyIdToken", () => {
  it("正しいトークンは通る", async () => {
    const result = await verifyIdToken(await sign({}), PROJECT_ID, { now: NOW, fetchJwks });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.email).toBe("tester@example.invalid");
  });

  it("別の鍵で署名されていたら落とす", async () => {
    const token = await sign({}, { key: otherPair.privateKey });
    const result = await verifyIdToken(token, PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("知らない kid は落とす", async () => {
    const token = await sign({}, { kid: "unknown-kid" });
    const result = await verifyIdToken(token, PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("iss が違えば落とす", async () => {
    const token = await sign({ iss: "https://securetoken.google.com/someone-else" });
    const result = await verifyIdToken(token, PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "bad_issuer" });
  });

  it("aud が違えば落とす", async () => {
    const token = await sign({ aud: "someone-else" });
    const result = await verifyIdToken(token, PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "bad_audience" });
  });

  it("exp が切れていたら落とす", async () => {
    const token = await sign({ exp: NOW - 1 });
    const result = await verifyIdToken(token, PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("alg が RS256 でなければ落とす (alg=none 対策)", async () => {
    const token = await sign({}, { alg: "none" });
    const result = await verifyIdToken(token, PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "unsupported_alg" });
  });

  it("形が JWT でなければ落とす", async () => {
    const result = await verifyIdToken("not-a-jwt", PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});

// ⚠⚠ 同じプロジェクトの別 tenant でも iss / aud は同じなので、
//   ここが外れると別の tenant の利用者がそのまま入れる。
describe("verifyIdToken — tenant", () => {
  const TENANT = "users-a1b2c";

  it("tenant が一致すれば通る", async () => {
    const token = await sign({ firebase: { tenant: TENANT } });
    const result = await verifyIdToken(token, PROJECT_ID, {
      now: NOW,
      fetchJwks,
      tenantId: TENANT,
    });
    expect(result.ok).toBe(true);
  });

  it("別の tenant なら落とす", async () => {
    const token = await sign({ firebase: { tenant: "users-other-z9y8x" } });
    const result = await verifyIdToken(token, PROJECT_ID, {
      now: NOW,
      fetchJwks,
      tenantId: TENANT,
    });
    expect(result).toEqual({ ok: false, reason: "bad_tenant" });
  });

  it("tenant を設定しているのに、トークンが project 直下なら落とす", async () => {
    const result = await verifyIdToken(await sign({}), PROJECT_ID, {
      now: NOW,
      fetchJwks,
      tenantId: TENANT,
    });
    expect(result).toEqual({ ok: false, reason: "bad_tenant" });
  });

  it("tenant を設定していないのに、トークンに tenant があれば落とす", async () => {
    const token = await sign({ firebase: { tenant: TENANT } });
    const result = await verifyIdToken(token, PROJECT_ID, { now: NOW, fetchJwks });
    expect(result).toEqual({ ok: false, reason: "bad_tenant" });
  });
});
