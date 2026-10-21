import type { AnySpan } from "@mastra/core/observability";
import { describe, expect, it } from "vitest";
import {
  dataUrlMediaType,
  LargePayloadRedactor,
  looksBase64,
  omissionMarker,
  redactLargePayloads,
} from "./span-redactor";

/** 長い base64 らしい文字列を作る。 */
function base64Like(length: number): string {
  return "A".repeat(length);
}

describe("omissionMarker", () => {
  it("大きさを人が読める形にする", () => {
    expect(omissionMarker(1_258_291, "image/jpeg")).toBe("[image/jpeg 1.2MB omitted]");
    expect(omissionMarker(4096, "base64")).toBe("[base64 4KB omitted]");
    expect(omissionMarker(12, "binary")).toBe("[binary 12B omitted]");
  });
});

describe("dataUrlMediaType", () => {
  it("data URL から media type を取る", () => {
    expect(dataUrlMediaType("data:image/jpeg;base64,/9j/4AAQ")).toBe("image/jpeg");
  });

  it("data URL でなければ null", () => {
    expect(dataUrlMediaType("image/jpeg;base64,xxx")).toBeNull();
    expect(dataUrlMediaType("ふつうの文章")).toBeNull();
  });

  /** ⚠ 先頭だけを見る (長い文字列を端まで走査しない)。 */
  it("`;base64,` が頭から遠ければ data URL と見なさない", () => {
    expect(dataUrlMediaType(`data:${"x".repeat(200)};base64,AAAA`)).toBeNull();
  });
});

describe("looksBase64", () => {
  it("base64 の文字種だけなら真", () => {
    expect(looksBase64("/9j/4AAQSkZJRgABAQAA+abc-_=")).toBe(true);
  });

  it("日本語や空白が混ざれば偽", () => {
    expect(looksBase64("これは文章です")).toBe(false);
    expect(looksBase64("AAAA BBBB")).toBe(false);
  });

  it("空文字は偽", () => {
    expect(looksBase64("")).toBe(false);
  });
});

describe("redactLargePayloads", () => {
  it("★ 画像は data URL の形で載るので、media type つきの目印に替える", () => {
    // ⚠⚠ 実測のモデル入力の形。キーは dataBase64 ではなく data。
    const input = {
      content: [
        { type: "text", text: "発注書を読み取ってください。" },
        { type: "file", mediaType: "image/jpeg", data: `data:image/jpeg;base64,${base64Like(5000)}` },
      ],
    };
    const output = redactLargePayloads(input) as typeof input;

    expect(output.content[1]!.data).toMatch(/^\[image\/jpeg .* omitted\]$/);
    // 文章はそのまま残る (何をさせた呼び出しか分かること)。
    expect(output.content[0]!.text).toBe("発注書を読み取ってください。");
  });

  it("素の base64 (PDF の dataBase64) も目印に替える", () => {
    const output = redactLargePayloads({ dataBase64: base64Like(50_000) }) as {
      dataBase64: string;
    };
    expect(output.dataBase64).toMatch(/^\[base64 .* omitted\]$/);
  });

  it("短い base64 は素通しする (識別子などを壊さない)", () => {
    const value = { token: base64Like(100) };
    expect(redactLargePayloads(value)).toBe(value);
  });

  /** ⚠⚠ 指示文は実測 10,936 文字。ここが消えると「どの指示文で読んだか」が読めない。 */
  it("指示文くらいの長さの日本語は素通しする", () => {
    const instructions = "あ".repeat(11_000);
    const value = { instructions };
    expect(redactLargePayloads(value)).toBe(value);
  });

  it("桁違いに長い文字列は頭だけ残す", () => {
    const output = redactLargePayloads({ text: "あ".repeat(40_000) }) as { text: string };
    expect(output.text.startsWith("あ".repeat(1000))).toBe(true);
    expect(output.text).toMatch(/…\[text .* omitted\]$/);
  });

  it("バイト列は目印に替える", () => {
    const output = redactLargePayloads({ bytes: new Uint8Array(2048) }) as { bytes: string };
    expect(output.bytes).toBe("[binary 2KB omitted]");
  });

  it("⚠⚠ 元の値を書き換えない (workflow がまだ使っている実体のため)", () => {
    const data = `data:image/jpeg;base64,${base64Like(5000)}`;
    const input = { request: { dataBase64: base64Like(50_000) }, image: { data } };
    const before = JSON.stringify(input);

    const output = redactLargePayloads(input);

    expect(output).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.image.data).toBe(data);
  });

  it("⚠ 置き換えが 1 つも無ければ同じ参照を返す (無駄な器を作らない)", () => {
    const value = { a: 1, b: ["x", { c: "y" }] };
    expect(redactLargePayloads(value)).toBe(value);
  });

  it("循環参照でも落ちない", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    const output = redactLargePayloads(value) as Record<string, unknown>;
    expect(output.self).toBe("[Circular Reference]");
  });

  it("⚠ 同じ器を 2 か所から指すのは循環ではない (どちらも中身が残る)", () => {
    const shared = { label: "同じもの" };
    const output = redactLargePayloads({ a: shared, b: shared }) as {
      a: typeof shared;
      b: typeof shared;
    };
    expect(output.a).toEqual(shared);
    expect(output.b).toEqual(shared);
  });

  it("深すぎる入れ子は打ち切る", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 20; index++) deep = { child: deep };
    const output = JSON.stringify(redactLargePayloads(deep));
    expect(output).toContain("[depth limit]");
  });

  it("Date は器を作り直さない", () => {
    const at = new Date("2000-01-01T00:00:00.000Z");
    const output = redactLargePayloads({ at }) as { at: Date };
    expect(output.at).toBe(at);
  });
});

describe("LargePayloadRedactor", () => {
  /** span の形だけを真似た最小の器。 */
  function fakeSpan(fields: Record<string, unknown>): AnySpan {
    return { traceId: "t1", ...fields } as unknown as AnySpan;
  }

  it("input / output / attributes / metadata を小さくする", () => {
    const span = fakeSpan({
      input: { dataBase64: base64Like(50_000) },
      output: { text: "ok" },
      attributes: { instructions: "短い指示文" },
      metadata: { image: `data:image/jpeg;base64,${base64Like(5000)}` },
    });

    const processed = new LargePayloadRedactor().process(span) as unknown as Record<
      string,
      Record<string, string>
    >;

    expect(processed.input!.dataBase64).toMatch(/omitted\]$/);
    expect(processed.metadata!.image).toMatch(/^\[image\/jpeg /);
    expect(processed.output!.text).toBe("ok");
    expect(processed.attributes!.instructions).toBe("短い指示文");
  });

  /**
   * ⚠⚠ 呼ぶ側 (`processSpan`) で例外を捕まえると、編集前の巨大な span がそのまま
   *   export される。欄ごとに握りつぶして、残りの欄は小さくする。
   */
  it("欄の 1 つが壊れていても span を返し、他の欄は小さくする", () => {
    const broken: Record<string, unknown> = {};
    Object.defineProperty(broken, "boom", {
      enumerable: true,
      get() {
        throw new Error("読めない欄");
      },
    });
    const span = fakeSpan({ input: broken, output: { dataBase64: base64Like(50_000) } });

    const processed = new LargePayloadRedactor().process(span) as unknown as Record<
      string,
      Record<string, string>
    >;

    expect(processed).toBeDefined();
    expect(processed.output!.dataBase64).toMatch(/omitted\]$/);
  });

  it("span が無ければそのまま返す", () => {
    expect(new LargePayloadRedactor().process(undefined)).toBeUndefined();
  });

  it("2 回通しても結果が変わらない (export のたびに走っても壊れない)", () => {
    const span = fakeSpan({ input: { dataBase64: base64Like(50_000) } });
    const redactor = new LargePayloadRedactor();

    redactor.process(span);
    const first = JSON.stringify((span as unknown as { input: unknown }).input);
    redactor.process(span);

    expect(JSON.stringify((span as unknown as { input: unknown }).input)).toBe(first);
  });
});
