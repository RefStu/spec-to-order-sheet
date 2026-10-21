import { describe, expect, it } from "vitest";
import { bytesToBase64, sha256Hex } from "./base64";

describe("bytesToBase64", () => {
  it("短い配列を base64 にする", () => {
    expect(bytesToBase64(new TextEncoder().encode("%PDF-1.7"))).toBe("JVBERi0xLjc=");
  });

  it("空でも落ちない", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it("⚠ 鍵や PDF のような長い配列でもスタックを溢れさせない", () => {
    // String.fromCharCode(...bytes) だとこの大きさで落ちる。
    const bytes = new Uint8Array(1_000_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const encoded = bytesToBase64(bytes);
    // 詰め物込みの長さ = ceil(n/3)*4
    expect(encoded).toHaveLength(Math.ceil(bytes.length / 3) * 4);

    // チャンクの境界で壊れていないこと (戻して突き合わせる)。
    const decoded = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  it("チャンクの境界をまたぐ長さでも往復する", () => {
    for (const length of [0x7fff, 0x8000, 0x8001, 0x10000 + 2]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 7) % 256);
      const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (ch) => ch.charCodeAt(0));
      expect(decoded).toEqual(bytes);
    }
  });
});

describe("sha256Hex", () => {
  it("空のときの既知の値", async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("中身が違えば違うハッシュになる", async () => {
    const a = await sha256Hex(new TextEncoder().encode("po-a").buffer as ArrayBuffer);
    const b = await sha256Hex(new TextEncoder().encode("po-b").buffer as ArrayBuffer);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });
});
