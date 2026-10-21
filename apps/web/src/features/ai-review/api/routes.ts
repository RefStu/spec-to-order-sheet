import { zValidator } from "@hono/zod-validator";
import { createApp } from "../../../shared/hono";
import { readAccuracy } from "../services/accuracy-service";
import {
  createFormProfile,
  FormProfileConflict,
  deactivatePrompt,
  listFormProfiles,
  savePrompt,
  updateFormProfile,
} from "../services/form-profile-service";
import { createFormProfileInput, savePromptInput, updateFormProfileInput } from "../schema";

/**
 * /api/ai-review 配下。
 *
 * ⚠ 正答率は feature `metrics` を作らず、ai-review に置く。
 *   → `GET /api/ai-review/accuracy`
 * ⚠ **合否の判定は持たず、率だけを出す。**
 * ⚠ **メソッドチェーンのまま書くこと。** 途中で変数に代入すると hc の RPC 型が落ちる。
 *
 * ★ 様式と指示文 (画面の「発注書分類」) もここ。
 *   `ai_prompts` はこの feature の持ち物で、`partner_form_profiles` も境界の
 *   取り込み側に入っているため、1 か所で扱える。
 */
export const routes = createApp()
  .get("/accuracy", async (c) =>
    // 正答率 = そのまま採用された欄 ÷ (そのまま採用 + 人が直した)。欄単位で数える。
    c.json(await readAccuracy(c.env)),
  )

  /** 様式と指示文の一覧。**「この様式のときはこの指示文」はここに出る。** */
  .get("/form-profiles", async (c) => c.json(await listFormProfiles(c.env)))

  .post("/form-profiles", zValidator("json", createFormProfileInput), async (c) => {
    try {
      return c.json(await createFormProfile(c.env, c.req.valid("json")), 201);
    } catch (error) {
      if (error instanceof FormProfileConflict) {
        return c.json({ error: "same_code" }, 409);
      }
      throw error;
    }
  })

  .patch("/form-profiles/:id", zValidator("json", updateFormProfileInput), async (c) => {
    const ok = await updateFormProfile(c.env, c.req.param("id"), c.req.valid("json"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  })

  /**
   * 指示文を保存して使用中にする。
   * ⚠ **上書きではなく版を足す。** 前の版は残る (`ai_jobs.prompt_id` から辿れる)。
   */
  .post("/prompts", zValidator("json", savePromptInput), async (c) =>
    c.json(await savePrompt(c.env, c.req.valid("json")), 201),
  )

  /** 指示文をやめる (= ai の既定に戻す)。⚠ 消さずに降ろすだけ。 */
  .post("/prompts/:id/deactivate", async (c) => {
    const ok = await deactivatePrompt(c.env, c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });
