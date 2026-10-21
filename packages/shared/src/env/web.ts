import { z } from "zod";

/**
 * apps/web (Cloudflare Worker) が受け取る環境変数。
 * ⚠ キーを足したら `apps/web/.dev.vars.example` と `Bindings` (apps/web/src/shared/hono.ts) にも足すこと。
 */
export const webEnvSchema = z.object({
  /** Cloud Run (ai) の URL。ローカルでは gcp-emulator の gateway。 */
  AI_BASE_URL: z.url(),
  /** ID token を発行する token endpoint。ローカルでは gcp-emulator の /token。 */
  GOOGLE_TOKEN_URL: z.url(),
  /** invoker SA の鍵 (JSON 文字列)。 */
  AI_INVOKER_SA_KEY: z.string().min(1),

  // --- 利用者の認証 (Google Identity Platform) ---
  // ⚠ GIP のテナントを作るまでは空文字で通す。空のときは ID token の
  //   検証ができないので、ローカルに限り AUTH_DEV_BYPASS の代替サインインを使う。
  /** GIP の GCP プロジェクト ID。ID token の iss / aud の照合に使う。 */
  GIP_PROJECT_ID: z.string().default(""),
  /** この環境の GIP tenant。ID token の firebase.tenant の照合と、サインインに使う。 */
  GIP_TENANT_ID: z.string().optional(),
  /** GIP の authDomain (<project>.firebaseapp.com)。ブラウザへ配るだけ。 */
  GIP_AUTH_DOMAIN: z.string().default(""),
  /** GIP の Web API キー。ブラウザに配る公開値だが、プロジェクト固有なので secret で持つ。 */
  GIP_API_KEY: z.string().optional(),
  /** ⚠ ローカル専用の代替サインイン。ローカルの `.dev.vars` にだけ置く。 */
  AUTH_DEV_BYPASS: z.string().optional(),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
