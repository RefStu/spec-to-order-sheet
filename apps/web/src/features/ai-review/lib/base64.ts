/**
 * R2 から読んだ PDF を base64 にする。
 *
 * ⚠ **`btoa(String.fromCharCode(...bytes))` を書かないこと。** 引数を展開して渡すので、
 *   PDF のような長い配列では **スタックが溢れて落ちる** (Workers で踏みやすい罠)。
 *   ここでは一定の大きさに切って詰む。
 * ⚠ Workers に `Buffer` は無いので `btoa` を使う。
 *
 * base64 は 3 バイト = 4 文字で区切られるので、**チャンクは 3 の倍数**にする。
 * そうしないと境界ごとに "=" の詰め物が入って壊れる。
 */
const CHUNK_BYTES = 0x8000; // 32768 = 3 の倍数

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    let part = "";
    for (const byte of chunk) part += String.fromCharCode(byte);
    binary += part;
  }
  return btoa(binary);
}

/** 内容のハッシュ。同じ発注書の二重取り込みを防ぐ (`files.sha256`)。 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  // ⚠ `node:crypto` は Workers に無い。WebCrypto を使う。
  const digest = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * base64 をバイト列に戻す (ai が切り出した代表の図を受け取る)。
 *
 * ⚠ Workers に `Buffer` は無いので `atob`。`atob` の戻りは 1 文字 = 1 バイトの文字列なので、
 *   **1 文字ずつ**詰める (`Uint8Array.from(s, c => c.charCodeAt(0))` でもよいが、
 *   `String.fromCharCode(...)` のような展開は書かない — スタックが溢れる)。
 */
export function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
