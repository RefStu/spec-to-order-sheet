/**
 * ★ xlsx (= zip) を **Workers の中で**書き出す。
 *
 * ⚠⚠ **依存を足さない。** `node:*` も `Buffer` も無く、zip のライブラリは
 *   どれも node 前提のものが多い。必要なのは「書く」だけで、**読む処理は要らない**
 *   (雛形は展開済みの XML 文字列として持っているため)。
 *   → CRC32 + `CompressionStream("deflate-raw")` + ヘッダの組み立てで足りる。
 * ⚠ `CompressionStream` は workerd にも node 22 にもある (同じコードがテストで回る)。
 * ⚠ `String.fromCharCode(...bytes)` を使わない (長い配列でスタックが溢れる)。
 */

/** CRC-32 (IEEE)。zip の各エントリに要る。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** raw deflate (zip の method 8)。 */
export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipEntry {
  /** zip の中のパス (`xl/worksheets/sheet1.xml` など)。 */
  path: string;
  data: Uint8Array;
}

/** 数値を little endian で書く。 */
function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}
function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * zip を組み立てる。
 *
 * ⚠ **日時は固定**にしてある。同じ中身なら同じバイト列になるので、テストで比べられる。
 * ⚠ `store: true` は無圧縮。実物の xlsx も画像は無圧縮で持っているので、Excel は開ける。
 *   圧縮が使えない環境に落ちたときの保険。
 */
export async function buildZip(
  entries: readonly ZipEntry[],
  options: { store?: boolean } = {},
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  /*
   * ⚠⚠ **バイトを `number[]` に展開しない。** 以前は
   *   `locals.push(...compressed)` と `Uint8Array.from([...locals])` で組み立てていたが、
   *   これは**画像を入れた瞬間にスタックが溢れる**（引数の数に上限がある。冒頭の
   *   `String.fromCharCode(...bytes)` を使うなという警告と同じ罠）。
   *   XML だけの 90KB では通ってしまうので、**写真を入れるまで気づけなかった。**
   *   → チャンクをためて、最後に 1 つの `Uint8Array` へ写す。
   */
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const raw = entry.data;
    const compressed = options.store ? raw : await deflateRaw(raw);
    const method = options.store ? 0 : 8;
    const crc = crc32(raw);

    const header = Uint8Array.from([
      ...u32(0x04034b50),
      ...u16(20), // 展開に必要な版
      ...u16(0),
      ...u16(method),
      ...u16(0), // 時刻 (固定)
      ...u16(0x21), // 日付 (固定: 1980-01-01)
      ...u32(crc),
      ...u32(compressed.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0),
    ]);
    locals.push(header, name, compressed);

    central.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(method),
        ...u16(0),
        ...u16(0x21),
        ...u32(crc),
        ...u32(compressed.length),
        ...u32(raw.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      name,
    );
    offset += header.length + name.length + compressed.length;
  }

  const centralLength = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralLength),
    ...u32(offset),
    ...u16(0),
  ]);

  return concat([...locals, ...central, end]);
}

/** チャンクを 1 つの `Uint8Array` に写す。⚠ 展開 (`...`) を使わない (上の理由)。 */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
