import { describe, expect, it } from "vitest";
import { authenticate } from "./middleware";
import { stringToBase64Url } from "./base64url";
import { DEV_TOKEN_PREFIX } from "./dev-token";

const NOW = 1_700_000_000;

function devToken(payload: Record<string, unknown>): string {
  return DEV_TOKEN_PREFIX + stringToBase64Url(JSON.stringify(payload));
}

const validDev = devToken({
  sub: "dev-1",
  email: "tester@example.invalid",
  name: "テスト太郎",
  exp: NOW + 3600,
});

describe("authenticate — 代替サインインの安全弁", () => {
  it("GIP が未設定 かつ AUTH_DEV_BYPASS=1 なら通る", async () => {
    const user = await authenticate(validDev, { GIP_PROJECT_ID: "", AUTH_DEV_BYPASS: "1" }, NOW);
    expect(user).toEqual({
      uid: "dev-1",
      email: "tester@example.invalid",
      name: "テスト太郎",
      via: "dev",
    });
  });

  // ★ これが外れるとデプロイ先で無認証のまま API が通る。
  it("GIP_PROJECT_ID が入っていたら、AUTH_DEV_BYPASS=1 でも代替は通らない", async () => {
    const user = await authenticate(
      validDev,
      { GIP_PROJECT_ID: "some-project", AUTH_DEV_BYPASS: "1" },
      NOW,
    );
    expect(user).toBeUndefined();
  });

  it("AUTH_DEV_BYPASS が無ければ通らない", async () => {
    expect(await authenticate(validDev, { GIP_PROJECT_ID: "" }, NOW)).toBeUndefined();
  });

  it("AUTH_DEV_BYPASS が '1' 以外なら通らない", async () => {
    const env = { GIP_PROJECT_ID: "", AUTH_DEV_BYPASS: "true" };
    expect(await authenticate(validDev, env, NOW)).toBeUndefined();
  });

  it("期限切れの代替トークンは通らない", async () => {
    const expired = devToken({ sub: "d", email: "e@example.invalid", name: "n", exp: NOW - 1 });
    const env = { GIP_PROJECT_ID: "", AUTH_DEV_BYPASS: "1" };
    expect(await authenticate(expired, env, NOW)).toBeUndefined();
  });

  it("壊れた代替トークンは通らない", async () => {
    const env = { GIP_PROJECT_ID: "", AUTH_DEV_BYPASS: "1" };
    expect(await authenticate("dev.!!!not-base64!!!", env, NOW)).toBeUndefined();
    expect(await authenticate("not-a-dev-token", env, NOW)).toBeUndefined();
  });
});
