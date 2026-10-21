/**
 * UUIDv7 を作る。
 *
 * ⚠ **`crypto.randomUUID()` は v4 なので使えない。** v7 が要るのは 2 つの理由から:
 *   1. **INSERT の前に行 ID を決められる。** `ai_extraction_fields.target_row_id` は
 *      「どの行のどの列に書いたか」を指すので、本体を書く前に ID が要る。
 *   2. 先頭 48 bit が時刻なので索引の局所性がよい。
 *
 * ⚠ `node:crypto` は Workers に無い。乱数は WebCrypto (`crypto.getRandomValues`) から取る。
 *
 * 版は RFC 9562 の layout:
 *   48 bit の unix milli | ver(4bit)=7 | rand_a(12bit) | var(2bit)=0b10 | rand_b(62bit)
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 先頭 48 bit = unix ミリ秒 (ビッグエンディアン)。
  // ⚠ 2^48 ミリ秒を超えると破綻するが、それは西暦 10889 年。
  const ms = Math.floor(now);
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
