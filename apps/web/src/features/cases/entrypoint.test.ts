import { describe, expect, it, vi } from "vitest";

vi.mock("./services/case-service", () => ({
  createCase: vi.fn(),
  partnerExists: vi.fn(),
  updateCase: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
  // 本物の WorkerEntrypoint は ctx / env を protected で持つだけ。
  WorkerEntrypoint: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));

const { createCase, partnerExists, updateCase } = await import("./services/case-service");
const { CasesEntrypoint } = await import("./entrypoint");

/**
 * 取り込みパイプラインが案件を書き戻す RPC の口。
 *
 * ⚠⚠ **参照先の無い行を作らせないことが要点。** feature をまたぐ外部キーは張っていないので、
 *   実在しない取引先 ID を入れても DB は止めてくれず、案件一覧の LEFT JOIN が外れて
 *   「(取引先未設定)」になるだけ ——**気付けない壊れ方**をする。
 */
const entrypointWith = () =>
  new CasesEntrypoint({} as never, { DB: {} } as never) as unknown as {
    createCase: (input: unknown) => Promise<string>;
    updateCase: (caseId: string, patch: Record<string, string>) => Promise<boolean>;
  };

describe("CasesEntrypoint.createCase", () => {
  it("空の入力でも案件を起こして ID を返す (アップロードは `{}` で呼ぶ)", async () => {
    vi.mocked(createCase).mockResolvedValue("case-new");

    await expect(entrypointWith().createCase({})).resolves.toBe("case-new");
    expect(createCase).toHaveBeenLastCalledWith({}, {});
  });

  it("⚠ 型の違う欄は捨て、もう片方は道連れにしない", async () => {
    vi.mocked(createCase).mockResolvedValue("case-new");

    await entrypointWith().createCase({ partner: 1, specNo: "SPC-0001" });
    expect(createCase).toHaveBeenLastCalledWith({}, { partner: undefined, specNo: "SPC-0001" });
  });
});

describe("CasesEntrypoint.updateCase", () => {
  it("実在する取引先なら更新して true", async () => {
    vi.mocked(partnerExists).mockResolvedValue(true);
    vi.mocked(updateCase).mockResolvedValue({ caseId: "case-1" } as never);

    await expect(entrypointWith().updateCase("case-1", { partnerId: "p-1" })).resolves.toBe(true);
  });

  it("⚠ 実在しない取引先は断る (参照先の無い行を作らない)", async () => {
    vi.mocked(partnerExists).mockResolvedValue(false);
    vi.mocked(updateCase).mockResolvedValue({ caseId: "case-1" } as never);

    await expect(entrypointWith().updateCase("case-1", { partnerId: "nope" })).resolves.toBe(false);
    expect(updateCase).not.toHaveBeenCalled();
  });

  it("案件が無ければ false", async () => {
    vi.mocked(partnerExists).mockResolvedValue(true);
    vi.mocked(updateCase).mockResolvedValue(undefined);

    await expect(entrypointWith().updateCase("case-x", { specNo: "SPC-0001" })).resolves.toBe(
      false,
    );
  });

  it("取引先を指定しなければ存在確認をしない", async () => {
    vi.mocked(partnerExists).mockReset();
    vi.mocked(updateCase).mockResolvedValue({ caseId: "case-1" } as never);

    await entrypointWith().updateCase("case-1", { specNo: "SPC-0001" });
    expect(partnerExists).not.toHaveBeenCalled();
  });
});
