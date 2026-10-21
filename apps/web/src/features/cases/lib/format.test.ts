import { describe, expect, it } from "vitest";
import { elapsedLabel } from "./format";

/**
 * ★ 「いつから読み取り中か」。回り続けるスピナー以外の手がかりを人に渡す。
 * ⚠ しきい値 (`JOB_STALE_MS`) の判断はここではなく SQL + `foldStale()` が持つ。
 *   ここは**表示の言葉だけ**。
 */
describe("elapsedLabel", () => {
  const now = Date.parse("2025-01-01T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("進行中のジョブが無ければ null (何も出さない)", () => {
    expect(elapsedLabel(null, now)).toBeNull();
  });

  it("1 分未満は数字を出さない (3 秒ごとのポーリングで踊るため)", () => {
    expect(elapsedLabel(ago(20_000), now)).toBe("まもなく");
  });

  it("分で出す", () => {
    expect(elapsedLabel(ago(5 * 60_000), now)).toBe("5 分経過");
    expect(elapsedLabel(ago(59 * 60_000), now)).toBe("59 分経過");
  });

  it("1 時間を超えたら時間と分で出す", () => {
    expect(elapsedLabel(ago(75 * 60_000), now)).toBe("1 時間 15 分経過");
  });

  it("⚠ 時計のずれで未来の時刻が来ても負にしない", () => {
    expect(elapsedLabel(ago(-60_000), now)).toBe("まもなく");
  });

  it("⚠ 読めない値は null (画面に Invalid Date を出さない)", () => {
    expect(elapsedLabel("not-a-date", now)).toBeNull();
  });
});
