import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  renderAiRegistry,
  renderWebQueues,
  renderWebRouter,
  renderWebRoutes,
  scanFeatures,
  toCamel,
  toPascal,
} from "./gen-core.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gen-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function touch(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

describe("識別子の変換", () => {
  it("kebab-case を camel / Pascal にする", () => {
    expect(toCamel("user")).toBe("user");
    expect(toCamel("workflow-run")).toBe("workflowRun");
    expect(toCamel("a-2b-c")).toBe("a2bC");
    expect(toPascal("workflow-run")).toBe("WorkflowRun");
  });
});

describe("scanFeatures", () => {
  it("ディレクトリが無ければ空", () => {
    expect(scanFeatures(join(dir, "nope"), "server.ts")).toEqual([]);
  });

  it("entry があるものだけを名前順で返す", () => {
    touch(join(dir, "workflow-run/server.ts"));
    touch(join(dir, "chat/server.ts"));
    touch(join(dir, "ui-only/client.ts"));
    touch(join(dir, ".hidden/server.ts"));
    writeFileSync(join(dir, "README.md"), "");
    expect(scanFeatures(dir, "server.ts")).toEqual([
      { name: "chat", id: "chat" },
      { name: "workflow-run", id: "workflowRun" },
    ]);
  });

  it("kebab-case でない名前はエラー", () => {
    touch(join(dir, "BadName/server.ts"));
    expect(() => scanFeatures(dir, "server.ts")).toThrow(/kebab-case/);
  });
});

const two = [
  { name: "chat", id: "chat" },
  { name: "workflow-run", id: "workflowRun" },
];

describe("render", () => {
  it("web routes: 0 件でも createApp() を返し、AppType を export する", () => {
    const out = renderWebRoutes([]);
    expect(out).toContain("export const featureApi = createApp();");
    expect(out).toContain("export type AppType = typeof featureApi;");
    expect(out).toContain("export const featureNames = [] as const;");
    expect(out.startsWith("// ⚠ 自動生成ファイル")).toBe(true);
  });

  it("web routes: createApp() に .route() を静的に連結する", () => {
    const out = renderWebRoutes(two);
    expect(out).toContain('import { createApp } from "../shared/hono";');
    expect(out).toContain('import { api as chatApi } from "../features/chat/server";');
    expect(out).toContain(
      'import { api as workflowRunApi } from "../features/workflow-run/server";',
    );
    expect(out).toContain(
      'export const featureApi = createApp()\n  .route("/api/chat", chatApi)\n  .route("/api/workflow-run", workflowRunApi);',
    );
    expect(out).toContain('export const featureNames = ["chat","workflow-run"] as const;');
  });

  // ⚠ 総称の関数 (mountRoutes<A extends Hono<any, any, any>>) で受けると Schema が any に
  //   潰れて hc の RPC 型が消える。具体値を export しているかをここで固定する。
  it("web routes: 型が落ちる総称の関数を生成しない", () => {
    const out = renderWebRoutes(two);
    expect(out).not.toContain("mountRoutes");
    expect(out).not.toContain("Hono<any, any, any>");
  });

  it("web queues: consumer を集める", () => {
    expect(renderWebQueues([])).toContain("export const queueConsumers = [] as const;");
    const out = renderWebQueues(two);
    expect(out).toContain(
      'import { consumer as chatConsumer } from "../features/chat/queues/consumer";',
    );
    expect(out).toContain(
      "export const queueConsumers = [chatConsumer, workflowRunConsumer] as const;",
    );
  });

  it("web router: routes を展開して連結する", () => {
    expect(renderWebRouter([])).toContain("export const featureRoutes = [] as const;");
    const out = renderWebRouter(two);
    expect(out).toContain(
      'import { routes as workflowRunRoutes } from "../features/workflow-run/client";',
    );
    expect(out).toContain(
      "export const featureRoutes = [...chatRoutes, ...workflowRunRoutes] as const;",
    );
  });

  it("ai registry: feature を並べる", () => {
    expect(renderAiRegistry([])).toContain("export const features = [] as const;");
    const out = renderAiRegistry(two);
    expect(out).toContain('import { feature as chatFeature } from "../features/chat/feature";');
    expect(out).toContain("export const features = [chatFeature, workflowRunFeature] as const;");
  });

  it("同じ入力なら同じ出力 (書き込みの差分判定の前提)", () => {
    expect(renderWebRoutes(two)).toBe(renderWebRoutes([...two]));
  });
});
