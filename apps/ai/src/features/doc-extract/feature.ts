import { defineFeature } from "../../shared/feature";
import { docExtractApiRoutes } from "./api/routes";
import { documentExtractWorkflow } from "./workflows/document-extract";

// Mastra への登録。`make gen` が集めて mastra/index.ts に渡す。
// ⚠⚠ **agent は登録していない。** 流れは workflow の step が持ち、モデルの呼び出しは
//   step が `runExtraction()` で直接行う (`lib/run-extraction.ts` の冒頭)。
//   指示文とモデルは**引数**なので、並列に読んでも取り違えが起きない。
// ⚠ workflows は配列で渡す (登録のキーは id になる)。
export const feature = defineFeature({
  workflows: [documentExtractWorkflow],
  apiRoutes: docExtractApiRoutes,
});
