import { Agent } from "@mastra/core/agent";
import { registerApiRoute } from "@mastra/core/server";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFeature, mergeFeatures } from "./feature";

function agent(id: string) {
  return new Agent({ id, name: id, instructions: "test", model: "openai/gpt-5-mini" });
}

function workflow(id: string) {
  const schema = z.object({ value: z.string() });
  return createWorkflow({ id, inputSchema: schema, outputSchema: schema })
    .then(
      createStep({
        id: `${id}-step`,
        inputSchema: schema,
        outputSchema: schema,
        execute: async ({ inputData }) => inputData,
      }),
    )
    .commit();
}

function route(path: string) {
  return registerApiRoute(path, { method: "POST", handler: async (c) => c.json({}) });
}

describe("mergeFeatures", () => {
  it("agent と workflow を id をキーにしてまとめる", () => {
    const merged = mergeFeatures([
      defineFeature({
        agents: [agent("a")],
        workflows: [workflow("w")],
        apiRoutes: [route("/v1/a")],
      }),
      defineFeature({ agents: [agent("b")], workflows: [], apiRoutes: [route("/v1/b")] }),
    ]);
    expect(Object.keys(merged.agents)).toEqual(["a", "b"]);
    expect(Object.keys(merged.workflows)).toEqual(["w"]);
    expect(merged.apiRoutes).toHaveLength(2);
    // chatRoute は id で agent を引くので、キーと id が一致していること。
    expect(merged.agents.a?.id).toBe("a");
  });

  it("feature が無ければ空", () => {
    expect(mergeFeatures([])).toEqual({ agents: {}, workflows: {}, apiRoutes: [] });
  });

  it("id やパスが重複したら止める", () => {
    const dup = defineFeature({ agents: [agent("a")], workflows: [], apiRoutes: [] });
    expect(() => mergeFeatures([dup, dup])).toThrow(/agent の id が重複/);
    const w = defineFeature({ agents: [], workflows: [workflow("w")], apiRoutes: [] });
    expect(() => mergeFeatures([w, w])).toThrow(/workflow の id が重複/);
    const r = defineFeature({ agents: [], workflows: [], apiRoutes: [route("/v1/same")] });
    expect(() => mergeFeatures([r, r])).toThrow(/API ルートが重複/);
  });
});
