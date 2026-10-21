import { z } from "zod";

/**
 * UI から選べるモデルの一覧。
 *
 * ⚠ このファイルは mastra を import しない。contract.ts から参照され、
 *   web が `import type` で型を使うため (web の型検査に mastra を持ち込まない)。
 * ⚠⚠ **一覧に無い文字列が画面から届くと、契約の parse ごと落ちて 400 になり、
 *   そのノードだけでなくジョブ全体が失敗する。** 選べるものだけを載せること。
 * ⚠⚠ **足したら web の `MODEL_OPTIONS` (`apps/web/src/features/ai-review/schema.ts`) にも足す。**
 *   web 側は「消したとき」しか型検査で落ちない。
 *   ⚠ 例外は Gemini。**画面では選ばせない**ので web の一覧には載せていない。
 *
 * ★ Gemini は **local で測るために**載せた。
 *   - Mastra 1.67 のモデルルータが `google/*` を解決する。`@ai-sdk/google` は
 *     `@mastra/core` に同梱されているので**依存の追加は要らない**。Gemini を使うなら
 *     `GOOGLE_GENERATIVE_AI_API_KEY` を env に渡す。
 *   - ⚠⚠ **デプロイ先の Cloud Run にはこの鍵を渡していない。**
 *     鍵の無い環境で `google/*` を指定すると、**そのジョブは鍵が無くて失敗する**。
 *     web は `requestContext.model` を送っておらず、モデルを選ぶ画面も非表示なので、
 *     いまは画面から選ばれる経路が無い。デプロイ先で使うなら、先に鍵を配ること。
 *   - id は Mastra の `provider-registry.json` に載っているものだけ。
 *     Flash 系は安定版の最新 (`gemini-3.8-flash`)、Pro 系は 3.x の唯一の Pro (preview)。
 */
export const MODEL_IDS = [
  "openai/gpt-5-mini",
  "openai/gpt-5",
  "google/gemini-3.8-flash",
  "google/gemini-3.1-pro-preview",
] as const;

export const modelIdSchema = z.enum(MODEL_IDS);
export type ModelId = z.infer<typeof modelIdSchema>;
