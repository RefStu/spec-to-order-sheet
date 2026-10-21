import { getAiEnv } from "./env";
import { modelIdSchema } from "./model-ids";

/**
 * 使うモデルを決める。**一覧 (`model-ids.ts`) に無い値は `AI_DEFAULT_MODEL` に落とす。**
 *
 * ⚠ 画面から来る文字列をそのまま使わない (一覧に無いモデルを指定されても動き続ける)。
 * ⚠ **env は呼ばれたときに読む。** import しただけで env を要求しない。
 */
export function resolveModelId(value: string | undefined, fallback?: string): string {
  const parsed = modelIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // ⚠ **ここで初めて env を読む。** 既定の引数に書くと、モデルが指定されていても
  //   毎回 env を要求することになる (import しただけで env を要る形に近づく)。
  return fallback ?? getAiEnv().AI_DEFAULT_MODEL;
}
