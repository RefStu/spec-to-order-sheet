/**
 * gcp-emulator の本体。
 *
 * 1 プロセスで 3 つの役目を持つ。web 側の AI_BASE_URL と GOOGLE_TOKEN_URL が同じ host:port を
 * 指しているのと、ai-client.ts が `new URL("/v1/chat", AI_BASE_URL)` を作る (= パスが必ず
 * ルート絶対になる) ため、**パスの接頭辞で分けることはできない**。
 *
 *   POST /token              Google の token endpoint の代わり (assertion → ID token)
 *   GET  /jwks               ID token の署名鍵 (本番と形をそろえるため)
 *   GET  /__emulator/health  起動確認  ⚠ /health は Mastra が使っているので避ける
 *   その他                   Cloud Run IAM の代わり (検証してから ai へ転送)
 *
 * ⚠ **apps/web を直さずに繋がること**が、このサーバーの正しさの基準。web を直さないと
 *   繋がらないなら、それは emulator 側の誤り。形の正は apps/web/src/shared/ai/google-id-token.ts。
 */
import { Hono } from "hono";
import type { EmulatorConfig } from "./config.ts";
import { normalizeUrl } from "./config.ts";
import type { EmulatorKeys } from "./keys.ts";
import { decodeJwt, numberClaim, signJwt, stringClaim, verifySignature } from "./jwt.ts";
import { type FetchLike, proxyRequest } from "./proxy.ts";

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export interface EmulatorDeps {
  config: EmulatorConfig;
  loadKeys: () => EmulatorKeys;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** Google の token endpoint と同じ形のエラー。 */
function oauthError(error: string, description: string) {
  return { error, error_description: description };
}

/** Cloud Run (Google API) と同じ形のエラー。 */
function apiError(code: number, message: string, status: string) {
  return { error: { code, message, status } };
}

export function createEmulatorApp(deps: EmulatorDeps) {
  const { config, loadKeys, fetchImpl } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return (
    new Hono()
      .get("/__emulator/health", (c) =>
        c.json({ ok: true, upstream: config.aiUpstreamUrl, audience: config.expectedAudience }),
      )

      .get("/jwks", (c) => {
        const { google } = loadKeys();
        return c.json({ keys: [{ ...google.jwk, kid: google.kid, alg: "RS256", use: "sig" }] });
      })

      .post("/token", async (c) => {
        const form = new URLSearchParams(await c.req.text());
        const grantType = form.get("grant_type");
        const assertion = form.get("assertion");

        if (grantType !== JWT_BEARER_GRANT) {
          return c.json(
            oauthError(
              "unsupported_grant_type",
              `grant_type は ${JWT_BEARER_GRANT} にしてください`,
            ),
            400,
          );
        }
        if (!assertion) {
          return c.json(oauthError("invalid_request", "assertion がありません"), 400);
        }

        const { sa, google } = loadKeys();

        let jwt;
        try {
          jwt = decodeJwt(assertion);
        } catch (e) {
          return c.json(oauthError("invalid_request", (e as Error).message), 400);
        }
        if (!verifySignature(jwt, sa.publicKey)) {
          return c.json(oauthError("invalid_grant", "Invalid JWT Signature."), 400);
        }

        // ⚠ ローカル専用なので、**期待値と実際の値を本文に書く**。これが無いと原因が分からない。
        const audience = stringClaim(jwt.claims, "aud");
        if (!audience || normalizeUrl(audience) !== normalizeUrl(config.tokenUrl)) {
          return c.json(
            oauthError(
              "invalid_grant",
              `aud が違います (期待: ${config.tokenUrl} / 実際: ${String(audience)})。` +
                `apps/web/.dev.vars の GOOGLE_TOKEN_URL を確認してください。`,
            ),
            400,
          );
        }
        const issuer = stringClaim(jwt.claims, "iss");
        const subject = stringClaim(jwt.claims, "sub");
        if (issuer !== sa.clientEmail || subject !== sa.clientEmail) {
          return c.json(
            oauthError(
              "invalid_grant",
              `iss / sub が invoker SA ではありません (期待: ${sa.clientEmail} / 実際: ${String(issuer)} / ${String(subject)})。` +
                `apps/web/.dev.vars の AI_INVOKER_SA_KEY が make keys の出力と同じか確認してください。`,
            ),
            400,
          );
        }
        const expiresAt = numberClaim(jwt.claims, "exp");
        if (expiresAt === undefined || expiresAt <= now() - config.clockSkewSec) {
          return c.json(oauthError("invalid_grant", "assertion の有効期限が切れています"), 400);
        }
        const targetAudience = stringClaim(jwt.claims, "target_audience");
        if (!targetAudience) {
          return c.json(oauthError("invalid_grant", "target_audience がありません"), 400);
        }

        const issuedAt = now();
        const idToken = signJwt(
          { alg: "RS256", typ: "JWT", kid: google.kid },
          {
            // ⚠ 本物の ID token と同じ claims にしておく (後で本物の検証を足しても形が変わらない)。
            iss: "https://accounts.google.com",
            aud: targetAudience,
            sub: sa.clientId,
            azp: sa.clientId,
            email: sa.clientEmail,
            email_verified: true,
            iat: issuedAt,
            exp: issuedAt + config.idTokenTtlSec,
          },
          google.privateKey,
        );

        c.header("cache-control", "no-store");
        return c.json({
          id_token: idToken,
          expires_in: config.idTokenTtlSec,
          token_type: "Bearer",
        });
      })

      /**
       * Cloud Run IAM の代わり。
       *   401 … token が無い / 壊れている / 署名が合わない / 期限切れ
       *   403 … 署名は正しいが aud が違う / invoker SA でない
       * ⚠ 本物は token が **無い** とき 403 + HTML を返すが、ここでは 401 にしている
       *   (ローカルでは「不正」と「無い」を分ける意味が薄く、401 のほうが原因が分かりやすい)。
       * ⚠ Mastra Studio と /api もここを通るので、gateway 越しでは 401 になる。これは本番と同じ
       *   (Cloud Run の URL は IAM の後ろ)。Studio は PORT_AI を直接開く。
       */
      .all("*", async (c) => {
        const unauthorized = (message: string) => {
          c.header("www-authenticate", 'Bearer error="invalid_token"');
          return c.json(apiError(401, message, "UNAUTHENTICATED"), 401);
        };

        const authorization = c.req.header("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          return unauthorized(
            "Authorization ヘッダがありません。Cloud Run は ID token を必須にしています。",
          );
        }

        const { sa, google } = loadKeys();
        let jwt;
        try {
          jwt = decodeJwt(authorization.slice("Bearer ".length).trim());
        } catch (e) {
          return unauthorized(`ID token を読めません: ${(e as Error).message}`);
        }
        if (!verifySignature(jwt, google.publicKey)) {
          return unauthorized("ID token の署名が合いません。");
        }
        const expiresAt = numberClaim(jwt.claims, "exp");
        if (expiresAt === undefined || expiresAt <= now() - config.clockSkewSec) {
          return unauthorized("ID token の有効期限が切れています。");
        }

        const audience = stringClaim(jwt.claims, "aud");
        if (!audience || normalizeUrl(audience) !== config.expectedAudience) {
          return c.json(
            apiError(
              403,
              `aud が違います (期待: ${config.expectedAudience} / 実際: ${String(audience)})。` +
                `apps/web/.dev.vars の AI_BASE_URL を確認してください。`,
              "PERMISSION_DENIED",
            ),
            403,
          );
        }
        if (
          stringClaim(jwt.claims, "email") !== sa.clientEmail ||
          jwt.claims.email_verified !== true
        ) {
          return c.json(
            apiError(
              403,
              `invoker の権限がありません (期待: ${sa.clientEmail} / 実際: ${String(jwt.claims.email)})。`,
              "PERMISSION_DENIED",
            ),
            403,
          );
        }

        return proxyRequest(c.req.raw, config.aiUpstreamUrl, fetchImpl);
      })
  );
}
