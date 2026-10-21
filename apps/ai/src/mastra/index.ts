/**
 * Mastra の entry (`mastra dev` / `mastra build` の既定)。
 *
 * ⚠ ここには feature を書かない。features/<name>/feature.ts を registry.gen.ts
 *   (`make gen` が生成) 経由で読み、展開して渡すだけにする。
 *   手で編集すると、並行開発しているブランチ同士でこのファイルが衝突する。
 * ⚠ import は拡張子なしで書く (Mastra のバンドラが .ts 付きを解決できないため)。
 * ⚠ **このファイルの中でローカル変数を作らない。** Mastra の CLI は設定の項目
 *   (server など) だけを切り出して評価するので、ローカル変数を参照すると
 *   「apiRoutes is not defined」のようなエラーで起動できなくなる。
 *   参照してよいのは import したものだけ。
 */
import { Mastra } from "@mastra/core/mastra";
import { getAiEnv } from "../shared/env";
import { featureAgents, featureApiRoutes, featureWorkflows } from "../shared/feature";
import { createObservability } from "../shared/observability";
import { serverConfig } from "../shared/server";
import { getStorage } from "../shared/storage";
import { features } from "./registry.gen";

export const mastra = new Mastra({
  agents: featureAgents(features),
  workflows: featureWorkflows(features),
  storage: getStorage(),
  observability: createObservability(getAiEnv()),
  server: { ...serverConfig(getAiEnv()), apiRoutes: featureApiRoutes(features) },
});
