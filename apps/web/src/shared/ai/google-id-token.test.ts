import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIdToken, resetIdTokenCacheForTest } from "./google-id-token";

/**
 * ID token の組み立ての検査。
 *
 * ⚠ ここは web 側の組み立てだけを見る (受け取る側は infra/local/gcp-emulator のテスト)。
 *   実際に RSA 鍵を作って署名し、公開鍵で検証するところまでやる。
 * ⚠ node: を import しない (apps/web/src の規則)。鍵も base64 も Web 標準 API で扱う。
 */
const TOKEN_URL = "https://token.test/token";
const AUDIENCE = "https://ai.test";

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ⚠ 戻り値は Uint8Array<ArrayBuffer> と書く。既定の Uint8Array は ArrayBufferLike で、
//   crypto.subtle の BufferSource に渡せない (SharedArrayBuffer の可能性が残るため)。
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

let keyPair: CryptoKeyPair;
let env: { AI_INVOKER_SA_KEY: string; GOOGLE_TOKEN_URL: string };

beforeEach(async () => {
  resetIdTokenCacheForTest();
  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = toBase64(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  env = {
    GOOGLE_TOKEN_URL: TOKEN_URL,
    // ⚠ .env に入るときは改行が \n の 2 文字になる。その形で渡して直せることも確かめる。
    AI_INVOKER_SA_KEY: JSON.stringify({
      client_email: "invoker@example.iam.gserviceaccount.com",
      private_key: pem.replace(/\n/g, "\\n"),
    }),
  };
});

afterEach(() => vi.unstubAllGlobals());

/** token endpoint の代わり。受け取った assertion を記録して id_token を返す。 */
function stubTokenEndpoint(response: unknown = { id_token: "id-token-1", expires_in: 3600 }) {
  const calls: { url: string; assertion: string; grantType: string }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push({
      url: String(input),
      assertion: body.get("assertion") ?? "",
      grantType: body.get("grant_type") ?? "",
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

describe("getIdToken", () => {
  it("SA 鍵で署名した JWT を token endpoint に送り、id_token を返す", async () => {
    const calls = stubTokenEndpoint();
    const token = await getIdToken(env, AUDIENCE);

    expect(token).toBe("id-token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.grantType).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header, claims, signature] = calls[0]!.assertion.split(".");
    expect(decodeSegment(header!)).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = decodeSegment(claims!);
    expect(payload.iss).toBe("invoker@example.iam.gserviceaccount.com");
    // ⚠ aud は token endpoint、target_audience が Cloud Run の URL。入れ替えると 401 になる。
    expect(payload.aud).toBe(TOKEN_URL);
    expect(payload.target_audience).toBe(AUDIENCE);
    expect(Number(payload.exp)).toBeGreaterThan(Number(payload.iat));

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      base64UrlToBytes(signature!),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
  });

  it("同じ audience なら期限まで取り直さない", async () => {
    const calls = stubTokenEndpoint();
    await getIdToken(env, AUDIENCE);
    await getIdToken(env, AUDIENCE);
    expect(calls).toHaveLength(1);

    await getIdToken(env, "https://other.test");
    expect(calls).toHaveLength(2);
  });

  it("期限が短いときは毎回取り直す", async () => {
    const calls = stubTokenEndpoint({ id_token: "short", expires_in: 10 });
    await getIdToken(env, AUDIENCE);
    await getIdToken(env, AUDIENCE);
    expect(calls).toHaveLength(2);
  });

  it("鍵が壊れていたら分かるエラーにする", async () => {
    stubTokenEndpoint();
    await expect(getIdToken({ ...env, AI_INVOKER_SA_KEY: "not-json" }, AUDIENCE)).rejects.toThrow(
      /JSON として読めません/,
    );
    await expect(
      getIdToken({ ...env, AI_INVOKER_SA_KEY: '{"client_email":"x"}' }, AUDIENCE),
    ).rejects.toThrow(/client_email \/ private_key/);
  });

  it("token endpoint が失敗したら中身を添えて投げる", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    await expect(getIdToken(env, AUDIENCE)).rejects.toThrow(/403/);
  });
});
