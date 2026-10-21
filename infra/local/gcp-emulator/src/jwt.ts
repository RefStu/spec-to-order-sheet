/**
 * JWT の最小限の組み立てと検証。
 *
 * ⚠ **node:crypto だけで書く** (jose などは入れない)。正は apps/web の
 *   shared/ai/google-id-token.ts で、あちらは WebCrypto で同じことをしている。
 *   両者がずれないよう、形の決まりはここのコメントに書き写しておく。
 * ⚠ base64url は **padding を付けない**。web 側が `.replace(/=+$/, "")` しているので、
 *   受けるときも出すときも padding 無しで扱う (Buffer の "base64url" はどちらも読める)。
 */
import { type KeyObject, sign, verify } from "node:crypto";

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** 署名の対象 (`<header>.<claims>`)。 */
  signingInput: string;
  signature: Buffer;
}

export function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

export function encodeJsonBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** 形が違えば throw する。呼び出し側が 401 / 400 に振り分ける。 */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT が 3 つの部分に分かれていません");
  const [headerB64, claimsB64, signatureB64] = parts as [string, string, string];
  if (!headerB64 || !claimsB64 || !signatureB64) throw new Error("JWT に空の部分があります");

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("JWT の header / claims を JSON として読めません");
  }
  // ⚠ web 側の header は {"alg":"RS256","typ":"JWT"} だけで **kid が無い**。kid を要求しないこと。
  if (header.alg !== "RS256")
    throw new Error(`alg が RS256 ではありません (${String(header.alg)})`);

  return {
    header,
    claims,
    signingInput: `${headerB64}.${claimsB64}`,
    signature: Buffer.from(signatureB64, "base64url"),
  };
}

/** RS256 = RSASSA-PKCS1-v1_5 + SHA-256。node の既定の padding がこれ。 */
export function verifySignature(jwt: DecodedJwt, publicKey: KeyObject): boolean {
  return verify("sha256", Buffer.from(jwt.signingInput, "utf8"), publicKey, jwt.signature);
}

export function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const signingInput = `${encodeJsonBase64Url(header)}.${encodeJsonBase64Url(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

/** claims から数値を取り出す (無い / 数値でないなら undefined)。 */
export function numberClaim(claims: Record<string, unknown>, name: string): number | undefined {
  const value = claims[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringClaim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
