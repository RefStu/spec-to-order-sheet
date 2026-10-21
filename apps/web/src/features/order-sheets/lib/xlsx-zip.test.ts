import { describe, expect, it } from "vitest";
import { buildZip, crc32, deflateRaw } from "./xlsx-zip";

/**
 * ⚠ 出来たバイト列を**自分の実装で読み返さない**。
 *   中央ディレクトリを手で解いて `DecompressionStream` で戻し、元の文字列と比べる。
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}
function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

/** zip を解いて `パス → 中身` にする。 */
async function readZip(zip: Uint8Array): Promise<Record<string, string>> {
  // EOCD を末尾から探す。
  let eocd = zip.length - 22;
  while (eocd >= 0 && u32(zip, eocd) !== 0x06054b50) eocd--;
  expect(eocd).toBeGreaterThanOrEqual(0);

  const count = u16(zip, eocd + 10);
  let at = u32(zip, eocd + 16);
  const out: Record<string, string> = {};

  for (let i = 0; i < count; i++) {
    expect(u32(zip, at)).toBe(0x02014b50);
    const method = u16(zip, at + 10);
    const compressedSize = u32(zip, at + 20);
    const nameLength = u16(zip, at + 28);
    const localOffset = u32(zip, at + 42);
    const path = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));

    const localNameLength = u16(zip, localOffset + 26);
    const localExtraLength = u16(zip, localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(start, start + compressedSize);

    if (method === 0) {
      out[path] = decoder.decode(body);
    } else {
      const stream = new Blob([body as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      out[path] = decoder.decode(await new Response(stream).arrayBuffer());
    }
    at += 46 + nameLength + u16(zip, at + 30) + u16(zip, at + 32);
  }
  return out;
}

describe("crc32", () => {
  it("標準の検査値 (外の実装と突き合わせる)", () => {
    // CRC-32 の "check value"。実装を写し間違えるとここで落ちる。
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });

  it("空でも落ちない", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("deflateRaw", () => {
  it("往復できる (workerd にも node にもある API だけで書いている)", async () => {
    const text = "ORDER SHEET ".repeat(50);
    const packed = await deflateRaw(encoder.encode(text));
    const stream = new Blob([packed as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    expect(decoder.decode(await new Response(stream).arrayBuffer())).toBe(text);
  });
});

describe("buildZip", () => {
  const entries = [
    { path: "[Content_Types].xml", data: encoder.encode("<Types/>") },
    { path: "xl/worksheets/sheet1.xml", data: encoder.encode("<worksheet>値</worksheet>") },
  ];

  it("zip として読み返せる", async () => {
    const zip = await buildZip(entries);
    expect(Array.from(zip.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const read = await readZip(zip);
    expect(Object.keys(read).sort()).toEqual(["[Content_Types].xml", "xl/worksheets/sheet1.xml"]);
    expect(read["xl/worksheets/sheet1.xml"]).toBe("<worksheet>値</worksheet>");
  });

  it("無圧縮 (store) でも読み返せる — 圧縮が使えないときの保険", async () => {
    const read = await readZip(await buildZip(entries, { store: true }));
    expect(read["xl/worksheets/sheet1.xml"]).toBe("<worksheet>値</worksheet>");
  });

  it("同じ中身なら同じバイト列 (日時を固定してある)", async () => {
    const a = await buildZip(entries);
    const b = await buildZip(entries);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

/**
 * ★★ **画像を入れても落ちないこと。**
 *
 * ⚠⚠ 以前は `push(...bytes)` でバイトを引数に展開していた。XML だけの 90KB では
 *   通るが、**数百 KB の JPEG を入れた瞬間にスタックが溢れる**（このファイルの冒頭の
 *   `String.fromCharCode(...bytes)` を使うなという警告と同じ罠）。
 *   写真を xlsx に貼るまで踏まなかったので、ここで固定する。
 */
describe("大きなバイナリ", () => {
  it("1MB を入れても落ちず、CRC と中身が合う", async () => {
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;

    // ⚠ 画像は無圧縮で入れる (実物の xlsx も画像は store)。
    const zip = await buildZip([{ path: "xl/media/image1.jpg", data: big }], { store: true });
    expect(zip.byteLength).toBeGreaterThan(big.length);

    // ローカルヘッダの CRC が中身と合っている。
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(14, true)).toBe(crc32(big));

    // 本体がそのまま入っている (store なので生のバイト列)。
    const nameLength = view.getUint16(26, true);
    const body = zip.subarray(30 + nameLength, 30 + nameLength + big.length);
    expect(body.length).toBe(big.length);
    expect(body[0]).toBe(big[0]);
    expect(body[big.length - 1]).toBe(big[big.length - 1]);
  });
});
