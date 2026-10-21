import { SpanType } from "@mastra/core/observability";
import { LangfuseExporter } from "@mastra/langfuse";
import { describe, expect, it } from "vitest";
import { createExporters, createTracingConfig } from "./observability";
import { LargePayloadRedactor } from "./span-redactor";

const langfuse = {
  LANGFUSE_BASE_URL: "http://127.0.0.1:3000",
  LANGFUSE_PUBLIC_KEY: "pk-lf-local",
  LANGFUSE_SECRET_KEY: "sk-lf-local",
  LANGFUSE_ENVIRONMENT: "local",
};

describe("createExporters", () => {
  it("LANGFUSE_BASE_URL が無ければ Studio 用だけ", () => {
    const exporters = createExporters({
      LANGFUSE_BASE_URL: undefined,
      LANGFUSE_PUBLIC_KEY: undefined,
      LANGFUSE_SECRET_KEY: undefined,
      LANGFUSE_ENVIRONMENT: undefined,
    });
    expect(exporters).toHaveLength(1);
    expect(exporters.some((e) => e instanceof LangfuseExporter)).toBe(false);
  });

  it("LANGFUSE_BASE_URL があれば Langfuse も足す", () => {
    const exporters = createExporters(langfuse);
    expect(exporters).toHaveLength(2);
    expect(exporters.some((e) => e instanceof LangfuseExporter)).toBe(true);
  });
});

describe("createTracingConfig", () => {
  /**
   * ⚠⚠ **実測で 1 実行 7.4MB / 36 span あった。** span に PDF と画像の base64 が
   *   そのまま載ると、Langfuse の取り込みが落ちてトレースが途中までしか出ない。
   */
  it("巨大な値を目印に替える processor を入れている", () => {
    const config = createTracingConfig(langfuse);
    expect(config.spanOutputProcessors.some((p) => p instanceof LargePayloadRedactor)).toBe(true);
  });

  /** ⚠ 実測で 36 span のうち 16 本。stream していないので読む価値が無い。 */
  it("model_chunk を送らない", () => {
    expect(createTracingConfig(langfuse).excludeSpanTypes).toContain(SpanType.MODEL_CHUNK);
  });

  /** ⚠ モデル呼び出しの中身が消えると、どのノードが遅いのか分からなくなる。 */
  it("⚠ model_generation / model_step は外さない", () => {
    const excluded = createTracingConfig(langfuse).excludeSpanTypes as SpanType[];
    expect(excluded).not.toContain(SpanType.MODEL_GENERATION);
    expect(excluded).not.toContain(SpanType.MODEL_STEP);
  });

  /** ⚠ 指示文は実測 10,936 文字。ここが下がると「どの指示文で読んだか」が読めない。 */
  it("文字列の上限は指示文が残る大きさにする", () => {
    const max = createTracingConfig(langfuse).serializationOptions.maxStringLength;
    expect(max).toBeGreaterThan(11_000);
  });
});
