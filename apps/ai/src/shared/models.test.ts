import { describe, expect, it } from "vitest";
import { resolveModelId } from "./models";

const fallback = "openai/gpt-5-mini";

describe("resolveModelId", () => {
  it("一覧にあるモデルならそのまま使う", () => {
    expect(resolveModelId("openai/gpt-5", fallback)).toBe("openai/gpt-5");
  });

  it("未指定なら既定のモデルに戻す", () => {
    expect(resolveModelId(undefined, fallback)).toBe(fallback);
    expect(resolveModelId("", fallback)).toBe(fallback);
  });

  /**
   * ⚠ 画面から来る文字列をそのまま使わない。
   * ⚠ `MODEL_IDS` に無い id (古い Gemini など) は、選ばれても既定に落ちる。
   */
  it("一覧に無い値なら既定のモデルに戻す", () => {
    expect(resolveModelId("google/gemini-2.5-flash", fallback)).toBe(fallback);
    expect(resolveModelId("openai/o1-pro", fallback)).toBe(fallback);
  });
});
