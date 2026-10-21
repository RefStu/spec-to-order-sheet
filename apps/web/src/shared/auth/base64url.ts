/**
 * base64url の復号。
 *
 * ⚠ Workers には Buffer が無いので atob を使う。
 * ⚠ **`String.fromCharCode(...bytes)` を使わない。** 鍵のような長い配列で
 *   引数の数がスタックを溢れさせる。
 */
export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlToString(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input));
}

/**
 * base64url へ符号化する。
 *
 * ⚠ **`btoa(json)` を直に使わない。** btoa は Latin-1 しか受けないので、
 *   日本語が 1 文字でも入ると InvalidCharacterError で落ちる。先に UTF-8 にする。
 * ⚠ `String.fromCharCode(...bytes)` を使わない (長い配列でスタックが溢れる)。
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function stringToBase64Url(input: string): string {
  return bytesToBase64Url(new TextEncoder().encode(input));
}
