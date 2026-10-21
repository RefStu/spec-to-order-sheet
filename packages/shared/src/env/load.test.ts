import { describe, expect, it } from "vitest";
import { aiEnvSchema, EnvError, loadEnv, webEnvSchema } from "./index.ts";

const validAi = {
  AI_DEFAULT_MODEL: "openai/gpt-5-mini",
  LIBSQL_URL: "file:.local/data/mastra.db",
  LIBSQL_AUTH_TOKEN: "",
  OPENAI_API_KEY: "sk-test",
  GOOGLE_GENERATIVE_AI_API_KEY: "g-test",
};

describe("loadEnv", () => {
  it("正しい web の env を返す", () => {
    const env = loadEnv(webEnvSchema, {
      AI_BASE_URL: "http://127.0.0.1:4010",
      GOOGLE_TOKEN_URL: "http://127.0.0.1:4010/token",
      AI_INVOKER_SA_KEY: "{}",
      UNRELATED: "ignored",
    });
    expect(env).toEqual({
      AI_BASE_URL: "http://127.0.0.1:4010",
      GOOGLE_TOKEN_URL: "http://127.0.0.1:4010/token",
      AI_INVOKER_SA_KEY: "{}",
      // GIP はテナントを作る前でも起動できるよう既定が空文字。API キーと
      // AUTH_DEV_BYPASS は optional なので、渡さなければキーごと出ない。
      GIP_PROJECT_ID: "",
      GIP_AUTH_DOMAIN: "",
    });
  });

  it("web: GIP の設定が無くても通る (テナントを作る前でも起動できる)", () => {
    const env = loadEnv(webEnvSchema, {
      AI_BASE_URL: "http://127.0.0.1:4010",
      GOOGLE_TOKEN_URL: "http://127.0.0.1:4010/token",
      AI_INVOKER_SA_KEY: "{}",
    });
    expect(env.GIP_PROJECT_ID).toBe("");
    expect(env.GIP_API_KEY).toBeUndefined();
    expect(env.AUTH_DEV_BYPASS).toBeUndefined();
  });

  it("足りないキーをすべて列挙して throw する", () => {
    try {
      loadEnv(webEnvSchema, { AI_BASE_URL: "not-a-url" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const keys = (e as EnvError).issues.map((i) => i.split(":")[0]);
      expect(keys).toEqual(["AI_BASE_URL", "GOOGLE_TOKEN_URL", "AI_INVOKER_SA_KEY"]);
      expect((e as EnvError).message).toContain(".example");
    }
  });

  it("ai: 空文字の任意キーは undefined になり、Langfuse は無効のまま通る", () => {
    const env = loadEnv(aiEnvSchema, validAi);
    expect(env.LIBSQL_AUTH_TOKEN).toBeUndefined();
    expect(env.LANGFUSE_BASE_URL).toBeUndefined();
  });

  it("ai: モデル ID の形式を検査する", () => {
    expect(() => loadEnv(aiEnvSchema, { ...validAi, AI_DEFAULT_MODEL: "gpt-5-mini" })).toThrow(
      EnvError,
    );
    expect(() =>
      loadEnv(aiEnvSchema, { ...validAi, AI_DEFAULT_MODEL: "google/gemini-2.5-flash" }),
    ).not.toThrow();
  });

  it("ai: API キーは既定モデルの provider の分だけ必須", () => {
    const openaiOnly = { ...validAi, GOOGLE_GENERATIVE_AI_API_KEY: "" };
    expect(loadEnv(aiEnvSchema, openaiOnly).GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    expect(() =>
      loadEnv(aiEnvSchema, { ...openaiOnly, AI_DEFAULT_MODEL: "google/gemini-2.5-flash" }),
    ).toThrow(/AI_DEFAULT_MODEL/);
    expect(() => loadEnv(aiEnvSchema, { ...validAi, OPENAI_API_KEY: undefined })).toThrow(
      /API キー/,
    );
  });

  it("ai: PORT は数値にする", () => {
    expect(loadEnv(aiEnvSchema, { ...validAi, PORT: "4011" }).PORT).toBe(4011);
    expect(loadEnv(aiEnvSchema, validAi).PORT).toBeUndefined();
    expect(() => loadEnv(aiEnvSchema, { ...validAi, PORT: "abc" })).toThrow(EnvError);
  });

  it("ai: Langfuse の URL だけあってキーがないと失敗する", () => {
    expect(() =>
      loadEnv(aiEnvSchema, { ...validAi, LANGFUSE_BASE_URL: "http://127.0.0.1:3000" }),
    ).toThrow(/LANGFUSE_PUBLIC_KEY/);
    expect(() =>
      loadEnv(aiEnvSchema, {
        ...validAi,
        LANGFUSE_BASE_URL: "http://127.0.0.1:3000",
        LANGFUSE_PUBLIC_KEY: "pk-lf-local",
        LANGFUSE_SECRET_KEY: "sk-lf-local",
      }),
    ).not.toThrow();
  });

  it("ai: Turso に接続するときはトークンが必須", () => {
    expect(() => loadEnv(aiEnvSchema, { ...validAi, LIBSQL_URL: "libsql://db.turso.io" })).toThrow(
      /LIBSQL_AUTH_TOKEN/,
    );
    expect(() =>
      loadEnv(aiEnvSchema, {
        ...validAi,
        LIBSQL_URL: "libsql://db.turso.io",
        LIBSQL_AUTH_TOKEN: "t",
      }),
    ).not.toThrow();
  });
});
