import { Hono } from "hono";
import type { D1Database, Fetcher, Queue, R2Bucket } from "@cloudflare/workers-types";
// ⚠ 型だけ。値を import すると shared が feature の実装を抱え込む。
import type { CasesEntrypoint } from "../features/cases/entrypoint";
import { authMiddleware, type AuthUser } from "./auth/middleware";

/**
 * Worker の binding。
 *
 * ⚠ 形の正は apps/web/wrangler.jsonc (binding) と packages/shared/src/env/web.ts (環境変数) の 2 つ。
 *   変数を足すときは packages/shared/src/env/web.ts と apps/web/.dev.vars.example も同時に直す。
 * ⚠ **import した時点で env を読まない。** Worker のモジュールスコープは isolate の起動時に
 *   走り、そこに env はまだ無い。値は必ずリクエストの中で `c.env` から取る。
 */
export interface Bindings {
  /** Static Assets (React SPA)。not_found_handling で index.html を返す。 */
  ASSETS: Fetcher;
  DB: D1Database;
  /** 受け取った PDF・画像の実体。参照 (files / file_pages) は D1 に持つ。 */
  FILES_BUCKET: R2Bucket;
  JOBS_QUEUE: Queue<unknown>;
  /**
   * 自分自身への service binding (RPC)。アップロードが案件を起こし、取り込みの consumer が書き戻すのに使う。
   *
   * ⚠ **fetch ハンドラを通らない**ので authMiddleware も通らない。だからパイプラインに
   *   資格情報を持たせずに済む。誰が呼べるかは wrangler.jsonc の宣言だけで決まる。
   * ⚠ ブラウザからは呼べない (URL が生えない)。
   */
  CASES: Pick<CasesEntrypoint, "createCase" | "updateCase">;
  /** Cloud Run (ai) の URL。ローカルは gcp-emulator の gateway。 */
  AI_BASE_URL: string;
  GOOGLE_TOKEN_URL: string;
  /** invoker SA の鍵 (JSON 文字列)。ローカルのダミー鍵は make keys が作る。 */
  AI_INVOKER_SA_KEY: string;

  // --- 利用者の認証 (Google Identity Platform) ---
  /** GIP の GCP プロジェクト ID。ID token の iss / aud の照合に使う。未設定なら空文字。 */
  GIP_PROJECT_ID: string;
  /**
   * GIP tenant。ID token の firebase.tenant と一致しなければ通さない。
   */
  GIP_TENANT_ID?: string;
  /** GIP の authDomain (<project>.firebaseapp.com)。ブラウザへ配るだけ。 */
  GIP_AUTH_DOMAIN: string;
  /** GIP の Web API キー。ブラウザに配る前提の公開値だがプロジェクト固有なので secret で持つ。 */
  GIP_API_KEY?: string;
  /**
   * ⚠ **ローカル専用の代替サインイン。** GIP を用意しないで動かすときに使う。
   *   ローカルの `.dev.vars` にだけ置き、デプロイ先には配らない。
   *   さらに middleware は GIP_PROJECT_ID が空のときしか受け付けない (auth/middleware.ts)。
   */
  AUTH_DEV_BYPASS?: string;
}

export interface HonoEnv {
  Bindings: Bindings;
  Variables: {
    /** authMiddleware が入れる。未認証のリクエストはここまで来ない。 */
    auth?: AuthUser;
  };
}

/**
 * feature の API はこれで作る。
 *
 * ⚠ 共通の middleware はここに入れる。app/routes.gen.ts が `createApp()` に
 *   `.route()` を連結してアプリを組み立てるので、あとから足す場所が無い。
 * ⚠ 呼び出し側は **メソッドチェーンのまま** 書くこと。途中で変数に代入すると hc の型が落ちる。
 * ⚠ authMiddleware は root (routes.gen.ts) と各 feature の sub-app の両方で走る。
 *   2 度目は c.get("auth") を見て素通りするので、検証は 1 リクエストに 1 回だけ。
 */
export function createApp() {
  return new Hono<HonoEnv>()
    .onError((err, c) => {
      console.error("[web] unhandled", err);
      // ⚠ 例外の中身をそのまま返さない (env の値が混ざることがある)。
      return c.json({ error: "internal_error" }, 500);
    })
    .use("*", authMiddleware);
}
