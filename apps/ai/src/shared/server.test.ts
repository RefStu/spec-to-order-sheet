import { describe, expect, it } from "vitest";
import { DEFAULT_AI_REQUEST_TIMEOUT_MS, serverConfig } from "./server";

/**
 * ⚠⚠ **Mastra の既定 (180 秒) では内包 PDF を読み切れない。**
 *   分類 + 発注書 + 依頼書の枚数ぶんが 1 リクエストの中で走るので、既定のままだと
 *   ai が 504 を返し、**モデルが読み終えた結果ごと捨てられる**。
 */
describe("Mastra の HTTP サーバー設定", () => {
  it("読み取りの上限を明示する (既定の 180 秒では足りない)", () => {
    expect(serverConfig({ PORT: 4111 }).timeout).toBe(DEFAULT_AI_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_AI_REQUEST_TIMEOUT_MS).toBeGreaterThan(180 * 1000);
  });

  /**
   * ⚠⚠ **値の正は env の AI_REQUEST_TIMEOUT_MS。**
   *   ここが env を見ないと、値を変えても**アプリだけ既定のまま**になり、
   *   デプロイ先の request timeout との短いほうで切れる。
   */
  it("⚠⚠ env の AI_REQUEST_TIMEOUT_MS を使う (既定より env を優先する)", () => {
    expect(serverConfig({ PORT: 4111, AI_REQUEST_TIMEOUT_MS: 1_200_000 }).timeout).toBe(1_200_000);
  });

  it("env に無ければ既定に落ちる (値を持たない環境でも起動できる)", () => {
    expect(serverConfig({ PORT: 4111 }).timeout).toBe(DEFAULT_AI_REQUEST_TIMEOUT_MS);
  });

  it("port は env から、host は全インターフェース (コンテナの外から届くように)", () => {
    expect(serverConfig({ PORT: 4321 })).toMatchObject({ port: 4321, host: "0.0.0.0" });
  });
});
