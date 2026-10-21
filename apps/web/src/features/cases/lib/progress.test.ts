import { describe, expect, it } from "vitest";
import {
  foldStale,
  parseProgressNodes,
  progressOf,
  stagesOf,
  toCount,
  type JobCounts,
  type JobTypeCounts,
  type ProgressNode,
  type RawJobCounts,
} from "./progress";

const counts = (over: Partial<JobCounts> = {}): JobCounts => ({
  queued: 0,
  running: 0,
  failed: 0,
  total: 0,
  hasOrderSheet: false,
  ...over,
});

describe("progressOf — 案件のジョブを集約する", () => {
  it("ジョブが 1 件も無ければ null (dev-seed の案件)", () => {
    expect(progressOf(counts())).toBeNull();
  });

  it("積んだだけなら accepted", () => {
    expect(progressOf(counts({ queued: 3, total: 3 }))).toBe("accepted");
  });

  it("1 件でも走っていれば reading", () => {
    expect(progressOf(counts({ queued: 2, running: 1, total: 3 }))).toBe("reading");
  });

  /**
   * ⚠⚠ ここが集約の肝。最新 1 行では表現できないケース。
   */
  it("3 通のうち 1 通が失敗しても、残りが読み取り中なら reading", () => {
    expect(progressOf(counts({ running: 2, failed: 1, total: 3 }))).toBe("reading");
  });

  it("失敗が残っていても、積まれたままのものがあれば accepted", () => {
    expect(progressOf(counts({ queued: 1, failed: 1, total: 2 }))).toBe("accepted");
  });

  it("全部終わってから失敗が残っていれば failed", () => {
    expect(progressOf(counts({ failed: 1, total: 3, hasOrderSheet: true }))).toBe("failed");
  });

  it("全部成功して ORDER SHEET が立っていれば written", () => {
    expect(progressOf(counts({ total: 4, hasOrderSheet: true }))).toBe("written");
  });

  /**
   * ⚠⚠ `runOrderSheetGenerate` は発注書が 1 通も読めていなくても succeeded で畳む。
   *   依頼書だけ届いた案件で「書き込んだ」と出ないことを固定する。
   */
  it("全部成功でも ORDER SHEET が無ければ null (依頼書だけ届いた案件)", () => {
    expect(progressOf(counts({ total: 2, hasOrderSheet: false }))).toBeNull();
  });

  it("読み取り中は ORDER SHEET の有無に関わらず reading", () => {
    expect(progressOf(counts({ running: 1, total: 2, hasOrderSheet: true }))).toBe("reading");
    expect(progressOf(counts({ running: 1, total: 2, hasOrderSheet: false }))).toBe("reading");
  });
});

/**
 * ★ 取り残し (落ちた consumer が残した running / 配られなかった queued)。
 *
 * ⚠⚠ **「進行中は失敗より先」を外さずに直す。** そこは原因ではない。
 *   直すのは**何を進行中と数えるか**のほう (`shared/ai-jobs.ts` の `JOB_STALE_MS`)。
 */
describe("foldStale — 取り残しを進行中から外す", () => {
  const raw = (over: Partial<RawJobCounts> = {}): RawJobCounts => ({
    ...counts(),
    staleQueued: 0,
    staleRunning: 0,
    ...over,
  });

  it("⚠ 正常な読み取り中は進行中のまま (しきい値を超えていない)", () => {
    const folded = foldStale(raw({ running: 1, total: 1, staleRunning: 0 }));
    expect(folded).toEqual(counts({ running: 1, total: 1 }));
    expect(progressOf(folded)).toBe("reading");
  });

  it("⚠⚠ 取り残しは進行中と数えない (failed に倒す)", () => {
    const folded = foldStale(raw({ running: 1, total: 1, staleRunning: 1, hasOrderSheet: true }));
    expect(folded).toEqual(counts({ failed: 1, total: 1, hasOrderSheet: true }));
    expect(progressOf(folded)).toBe("failed");
  });

  it("配られなかった queued も同じように畳む", () => {
    const folded = foldStale(raw({ queued: 1, total: 1, staleQueued: 1 }));
    expect(progressOf(folded)).toBe("failed");
  });

  it("取り残しが 1 件あっても、正常に走っている 1 件があれば reading のまま", () => {
    const folded = foldStale(raw({ running: 2, total: 2, staleRunning: 1 }));
    expect(folded.running).toBe(1);
    expect(folded.failed).toBe(1);
    expect(progressOf(folded)).toBe("reading");
  });

  it("⚠ 総数は変えない (ジョブが 1 件も無い案件と混ぜない)", () => {
    expect(foldStale(raw({ running: 1, total: 3, staleRunning: 1 })).total).toBe(3);
  });

  it("⚠ 内数が本数を超えても負にしない (SQL の食い違いで壊れない)", () => {
    const folded = foldStale(raw({ running: 1, total: 1, staleRunning: 5 }));
    expect(folded.running).toBe(0);
    expect(folded.failed).toBe(1);
  });
});

describe("toCount", () => {
  it("SUM が NULL でも 0 にする", () => {
    expect(toCount(null)).toBe(0);
    expect(toCount(undefined)).toBe(0);
  });

  it("D1 が文字列で返しても数にする", () => {
    expect(toCount("3")).toBe(3);
  });

  it("数にならないものは 0 (進み具合を NaN にしない)", () => {
    expect(toCount("x")).toBe(0);
  });
});

// ── 段 (縦に並べて出す) ──────────────────────────────────────────────────────

const noJobs: JobTypeCounts = {
  extract: { queued: 0, running: 0, failed: 0, total: 0 },
  generate: { queued: 0, running: 0, failed: 0, total: 0 },
};
const reading: JobTypeCounts = {
  extract: { queued: 0, running: 1, failed: 0, total: 1 },
  generate: { queued: 0, running: 0, failed: 0, total: 0 },
};
const shaping: JobTypeCounts = {
  extract: { queued: 0, running: 0, failed: 0, total: 1 },
  generate: { queued: 1, running: 0, failed: 0, total: 1 },
};
const finished: JobTypeCounts = {
  extract: { queued: 0, running: 0, failed: 0, total: 1 },
  generate: { queued: 0, running: 0, failed: 0, total: 1 },
};

const node = (over: Partial<ProgressNode> & Pick<ProgressNode, "node">): ProgressNode => ({
  label: over.node,
  stage: "extract",
  status: "running",
  at: 0,
  ...over,
});

describe("parseProgressNodes", () => {
  it("⚠ 壊れた JSON でも落ちない (見せるためだけの値)", () => {
    expect(parseProgressNodes(null)).toEqual([]);
    expect(parseProgressNodes("{")).toEqual([]);
    expect(parseProgressNodes('{"nodes":null}')).toEqual([]);
  });

  /** ⚠ 知らない段や状態が来たら**捨てる**。描こうとして段の順が崩れるより安全。 */
  it("⚠ 知らない stage / status の行は捨てる", () => {
    const json = JSON.stringify({
      nodes: {
        ok: { label: "発注書", stage: "extract", status: "running", at: 1 },
        bad: { label: "未来の段", stage: "unknown", status: "running", at: 2 },
        worse: { label: "未来の状態", stage: "extract", status: "paused", at: 3 },
      },
    });
    expect(parseProgressNodes(json).map((n) => n.node)).toEqual(["ok"]);
  });

  /** ⚠⚠ 鍵の名前で並べると `spec-10` が `spec-2` より前に来る。**報告の順**に並べる。 */
  it("⚠⚠ 報告された順に並べる (鍵の文字順ではない)", () => {
    const json = JSON.stringify({
      nodes: {
        "spec-10": { label: "依頼書 10 枚目", stage: "extract", status: "running", at: 20 },
        "spec-2": { label: "依頼書 2 枚目", stage: "extract", status: "running", at: 10 },
      },
    });
    expect(parseProgressNodes(json).map((n) => n.node)).toEqual(["spec-2", "spec-10"]);
  });
});

describe("stagesOf", () => {
  it("★ 段は 4 つを決まった順に返す (画面はこれを縦に並べる)", () => {
    const stages = stagesOf({ nodes: [], byType: noJobs, hasOrderSheet: false });
    expect(stages.map((s) => s.stage)).toEqual(["classify", "extract", "shape", "done"]);
  });

  /**
   * ⚠⚠ **並列は「同時に running が複数」で見せる。** ここで 1 本に畳むと、
   *   画面から並列であることが分からなくなる。
   */
  it("★★ 抽出の段に並列のノードがそのまま並ぶ", () => {
    const nodes: ProgressNode[] = [
      node({ node: "po", label: "発注書", status: "succeeded", at: 1 }),
      node({ node: "spec-1", label: "依頼書 1 枚目", status: "running", at: 2 }),
      node({ node: "spec-2", label: "依頼書 2 枚目", status: "running", at: 3 }),
      node({ node: "spec-3", label: "依頼書 3 枚目", status: "pending", at: 4 }),
    ];
    const extract = stagesOf({ nodes, byType: reading, hasOrderSheet: false })[1]!;

    expect(extract.stage).toBe("extract");
    expect(extract.status).toBe("running");
    expect(extract.nodes.map((n) => n.label)).toEqual([
      "発注書",
      "依頼書 1 枚目",
      "依頼書 2 枚目",
      "依頼書 3 枚目",
    ]);
    // 並列度を超えたぶんは待機のまま残る。**隠さないのが正しい。**
    expect(extract.nodes.filter((n) => n.status === "running")).toHaveLength(2);
    expect(extract.nodes.filter((n) => n.status === "pending")).toHaveLength(1);
  });

  it("⚠ 1 つでも失敗していたらその段は失敗", () => {
    const nodes = [
      node({ node: "spec-1", status: "succeeded" }),
      node({ node: "spec-2", status: "failed" }),
    ];
    expect(stagesOf({ nodes, byType: reading, hasOrderSheet: false })[1]?.status).toBe("failed");
  });

  /**
   * ⚠⚠ **ORDER SHEET を組むのは web の別ジョブ** (`order_sheet_generate`)。
   *   ai の対応づけが済んでも、生成ジョブが残っていればまだ「整形中」。
   */
  it("⚠⚠ ai の整形が済んでも、生成ジョブが残っていれば整形中のまま", () => {
    const nodes = [
      node({ node: "crop", stage: "shape", status: "succeeded" }),
      node({ node: "link", stage: "shape", status: "succeeded" }),
    ];
    const stages = stagesOf({ nodes, byType: shaping, hasOrderSheet: false });
    expect(stages[2]?.status).toBe("running");
    expect(stages[3]?.status).toBe("pending");
  });

  it("★ 全部終わって ORDER SHEET が立っていれば完了", () => {
    expect(stagesOf({ nodes: [], byType: finished, hasOrderSheet: true })[3]?.status).toBe(
      "succeeded",
    );
  });

  /** ⚠ 生成ジョブが成功しても ORDER SHEET が無いことがある (依頼書だけ届いた案件)。 */
  it("⚠ ORDER SHEET が無ければ完了にしない", () => {
    expect(stagesOf({ nodes: [], byType: finished, hasOrderSheet: false })[3]?.status).not.toBe(
      "succeeded",
    );
  });

  /**
   * ⚠⚠ **ai が黙っていても段は出す。** 戻り道の JSON ルートや、進捗を足す前に積まれた
   *   古いジョブでは `progress_json` が空。**内訳が出ないだけ**で、段は件数から近似する。
   */
  it("⚠⚠ ai が報告していなくても段は出る (内訳が空になるだけ)", () => {
    const stages = stagesOf({ nodes: [], byType: reading, hasOrderSheet: false });
    expect(stages[0]?.status).toBe("running");
    expect(stages[1]?.status).toBe("running");
    expect(stages[1]?.nodes).toEqual([]);
  });
});
