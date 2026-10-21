import { LibSQLStore } from "@mastra/libsql";
import { getAiEnv } from "./env";

/**
 * Mastra の保存先 (workflow の snapshot / trace)。
 * ローカルは file: DB、デプロイ先は libsql:// (Turso など)。
 *
 * ⚠ **ベクトルストア (`LibSQLVector`) は持たせていない。** 使っていたのは
 *   テンプレート由来の見本 (`rag`) だけで、このアプリの読み取り (`doc-extract`) は
 *   memory も vector も使わない (agent に memory を持たせない)。
 *   ⚠ 足すときは `new Mastra({ vectors })` と embedder (`OPENAI_API_KEY`) が対で要る。
 */

let store: LibSQLStore | undefined;

export function getStorage(): LibSQLStore {
  const { LIBSQL_URL, LIBSQL_AUTH_TOKEN } = getAiEnv();
  store ??= new LibSQLStore({
    id: "mastra-storage",
    url: LIBSQL_URL,
    authToken: LIBSQL_AUTH_TOKEN,
  });
  return store;
}
