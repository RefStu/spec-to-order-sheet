/**
 * 設定。**env からしか受け取らない。** 値は Makefile の `make dev` が渡す。
 */

export interface EmulatorConfig {
  port: number;
  host: string;
  /** 転送先 (= ai の PORT)。 */
  aiUpstreamUrl: string;
  /** assertion の `aud` の期待値。web の GOOGLE_TOKEN_URL と同じでなければならない。 */
  tokenUrl: string;
  /** ID token の `aud` の期待値。web の AI_BASE_URL と同じでなければならない。 */
  expectedAudience: string;
  keysFile: string;
  idTokenTtlSec: number;
  clockSkewSec: number;
}

/**
 * URL の比較用に末尾の `/` を落とす。
 * ⚠ AI_BASE_URL には末尾の `/` が無いが、人が env を書き換えたときに
 *   `http://127.0.0.1:4010/` になっていても 403 にしないため。
 */
export function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: Record<string, string | undefined>): EmulatorConfig {
  const port = intOr(env.PORT, 4010);
  const host = env.HOST || "127.0.0.1";
  return {
    port,
    host,
    aiUpstreamUrl: normalizeUrl(env.AI_UPSTREAM_URL || "http://127.0.0.1:4011"),
    tokenUrl: env.TOKEN_URL || `http://${host}:${port}/token`,
    expectedAudience: normalizeUrl(env.EXPECTED_AUDIENCE || `http://${host}:${port}`),
    keysFile: env.EMULATOR_KEYS_FILE || ".local/emulator/emulator-keys.json",
    idTokenTtlSec: intOr(env.ID_TOKEN_TTL_SEC, 3600),
    clockSkewSec: intOr(env.CLOCK_SKEW_SEC, 60),
  };
}
