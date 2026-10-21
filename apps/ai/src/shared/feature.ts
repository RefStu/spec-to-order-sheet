import type { Agent } from "@mastra/core/agent";
import type { ApiRoute } from "@mastra/core/server";
import type { AnyWorkflow } from "@mastra/core/workflows";

/**
 * feature が Mastra に登録するもの。features/<name>/feature.ts が `defineFeature` で export し、
 * `make gen` が mastra/registry.gen.ts に集める。
 */
export interface FeatureDefinition {
  /**
   * ⚠ **任意。** 帳票の読み取りのように「1 回聞いて終わり」の feature は agent を持たず、
   *   workflow の step が直接モデルを呼ぶ (`doc-extract/lib/run-extraction.ts`)。
   *   会話や memory が要るときだけ agent を登録する。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents?: readonly Agent<any, any, any>[];
  workflows: readonly AnyWorkflow[];
  apiRoutes: readonly ApiRoute[];
}

export function defineFeature<const F extends FeatureDefinition>(feature: F): F {
  return feature;
}

/**
 * features をまとめて `new Mastra()` に渡せる形にする。
 *
 * ⚠ agents / workflows のキーは **id** にする。chatRoute / workflowRoute は id で引くので、
 *   キーと id がずれると「登録したのに見つからない」になる。
 * ⚠ 別の feature と id やパスが重なったら起動時に止める (後勝ちで黙って上書きされるのを防ぐ)。
 */
/** agents だけを取り出す (mastra/index.ts 用)。 */
export function featureAgents(features: readonly FeatureDefinition[]) {
  return mergeFeatures(features).agents;
}

/** workflows だけを取り出す。 */
export function featureWorkflows(features: readonly FeatureDefinition[]) {
  return mergeFeatures(features).workflows;
}

/** apiRoutes だけを取り出す。 */
export function featureApiRoutes(features: readonly FeatureDefinition[]) {
  return mergeFeatures(features).apiRoutes;
}

export function mergeFeatures(features: readonly FeatureDefinition[]) {
  const agents: Record<string, NonNullable<FeatureDefinition["agents"]>[number]> = {};
  const workflows: Record<string, AnyWorkflow> = {};
  const apiRoutes: ApiRoute[] = [];
  const seenRoutes = new Set<string>();

  for (const feature of features) {
    for (const agent of feature.agents ?? []) {
      if (agents[agent.id]) throw new Error(`agent の id が重複しています: ${agent.id}`);
      agents[agent.id] = agent;
    }
    for (const workflow of feature.workflows) {
      if (workflows[workflow.id])
        throw new Error(`workflow の id が重複しています: ${workflow.id}`);
      workflows[workflow.id] = workflow;
    }
    for (const route of feature.apiRoutes) {
      const key = `${route.method} ${route.path}`;
      if (seenRoutes.has(key)) throw new Error(`API ルートが重複しています: ${key}`);
      seenRoutes.add(key);
      apiRoutes.push(route);
    }
  }
  return { agents, workflows, apiRoutes };
}
