import { z } from "zod";

/** "openai/gpt-5-mini" / "google/gemini-2.5-flash" の形。 */
const modelId = z
  .string()
  .regex(/^(openai|google)\/.+$/, '"openai/<model>" か "google/<model>" の形にしてください');

type Provider = "openai" | "google";

/** provider ごとの API キーの環境変数名。 */
export const PROVIDER_KEY = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const satisfies Record<Provider, string>;

function providerOf(modelId: string): Provider {
  return modelId.startsWith("google/") ? "google" : "openai";
}

/** 空文字は「未設定」として扱う (`.env.example` の `KEY=''`)。 */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

/**
 * apps/ai (Mastra / Cloud Run) が受け取る環境変数。
 * ⚠ キーを足したら `apps/ai/.env.example` にも足すこと。
 */
export const aiEnvSchema = z
  .object({
    AI_DEFAULT_MODEL: modelId,
    /** ローカルは file:、デプロイ先は libsql:// (Turso など)。 */
    LIBSQL_URL: z
      .string()
      .regex(
        /^(file:|libsql:\/\/|https?:\/\/)/,
        "file: / libsql:// / http(s):// のいずれかで始めてください",
      ),
    LIBSQL_AUTH_TOKEN: optionalString,
    /** どちらも任意。ただし AI_DEFAULT_MODEL の provider のキーは必須 (下の refine)。 */
    OPENAI_API_KEY: optionalString,
    GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
    /** ローカルの mastra dev の port。Cloud Run では自動で設定される。 */
    PORT: optionalString.pipe(
      z.string().regex(/^\d+$/, "数値にしてください").transform(Number).optional(),
    ),
    /**
     * ★ 読み取り 1 通ぶんの上限 (ミリ秒)。
     * ⚠⚠ **Cloud Run の request timeout もこの値以上にする。** **短いほうで切れる。**
     * ⚠ 既定は env 側 (`apps/ai/.env.example` / Terraform) に持たせる。ここは形の検査だけ。
     */
    AI_REQUEST_TIMEOUT_MS: optionalString.pipe(
      z.string().regex(/^\d+$/, "数値にしてください").transform(Number).optional(),
    ),
    /** 設定すると自前の Langfuse にトレースを送る。未設定なら exporter は無効。 */
    LANGFUSE_BASE_URL: optionalString.pipe(z.url().optional()),
    LANGFUSE_ENVIRONMENT: optionalString,
    LANGFUSE_PUBLIC_KEY: optionalString,
    LANGFUSE_SECRET_KEY: optionalString,
  })
  .refine((env) => env[PROVIDER_KEY[providerOf(env.AI_DEFAULT_MODEL)]] !== undefined, {
    message:
      "AI_DEFAULT_MODEL の provider の API キー (OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) が必要です",
    path: ["AI_DEFAULT_MODEL"],
  })
  .refine(
    (env) =>
      !env.LANGFUSE_BASE_URL ||
      (env.LANGFUSE_PUBLIC_KEY !== undefined && env.LANGFUSE_SECRET_KEY !== undefined),
    {
      message:
        "LANGFUSE_BASE_URL を設定するときは LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY も必要です",
      path: ["LANGFUSE_BASE_URL"],
    },
  )
  .refine((env) => !env.LIBSQL_URL.startsWith("libsql://") || env.LIBSQL_AUTH_TOKEN !== undefined, {
    message: "Turso (libsql://) に接続するときは LIBSQL_AUTH_TOKEN が必要です",
    path: ["LIBSQL_AUTH_TOKEN"],
  });

export type AiEnv = z.infer<typeof aiEnvSchema>;
