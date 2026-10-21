import type { ModelId } from "@repo/ai/contracts/doc-extract";
import { z } from "zod";

/**
 * ★ 発注書分類 (様式と指示文) の API の契約。
 *
 * ⚠⚠ **今回通すのは様式 1 つの例。様式は増える前提。**
 *   だから「この様式のときはこの指示文」は**データ**に持ち、コードに焼き付けない
 *   (`if (様式パターン①)` を書くと 2 件目で必ず壊れる)。
 * ⚠ 固有名詞を書かない。様式は「様式パターン①」の形で呼ぶ。
 */

/**
 * ★ 画面のモデル欄に出す一覧。**ai の `MODEL_IDS` の写し。**
 *
 * ⚠⚠ **自由入力にしない。** `ai_prompts.model_name` は web では文字列だが、ai の契約は
 *   この一覧の enum なので、**一覧に無い文字列を保存すると読み取りの要求ごと 400 になり、
 *   そのノードだけでなくジョブ全体が失敗する**（`doc-extract/api/routes.ts`）。
 * ⚠ **ai の `MODEL_IDS` は値なので import できない**（境界ルール: web は型だけ）。
 *   `satisfies readonly ModelId[]` を付けてあるので、ai がモデルを**消した**ときは
 *   型検査で落ちる。ai が**足した**ときは落ちないので、**出したいモデルはここにも足すこと。**
 * ⚠ **Gemini は ai の `MODEL_IDS` にはあるが、ここには載せない**。
 *   鍵が無い環境で選ぶとそのジョブは失敗する。試すときは ai の
 *   `/v1/doc-extract/document` に直接 `requestContext.model` を渡す。
 */
export const MODEL_OPTIONS = [
  "openai/gpt-5-mini",
  "openai/gpt-5",
] as const satisfies readonly ModelId[];
export type PromptModel = (typeof MODEL_OPTIONS)[number];

/** 一覧に載っているモデルか。⚠ **一覧を絞る前に保存された版**が DB に残っている。 */
export function isPromptModel(value: string | null | undefined): value is PromptModel {
  return MODEL_OPTIONS.some((model) => model === value);
}

/** 読み取りの workflow のノード。`ai_prompts.purpose` と 1 対 1。 */
export const promptRoleSchema = z.enum(["classify", "purchase_order", "spec_sheet"]);
export type PromptRole = z.infer<typeof promptRoleSchema>;

export const PROMPT_ROLE_LABEL: Record<PromptRole, string> = {
  classify: "分類 (何の帳票が何ページ目か)",
  purchase_order: "発注書の読み取り",
  spec_sheet: "依頼書の読み取り",
};

/** 様式が対象にする帳票。⚠ `mixed` = 発注書と依頼書が内包された 1 つの PDF。 */
export const formDocKindSchema = z.enum(["purchase_order", "spec_sheet", "mixed"]);
export type FormDocKind = z.infer<typeof formDocKindSchema>;

export const FORM_DOC_KIND_LABEL: Record<FormDocKind, string> = {
  purchase_order: "発注書",
  spec_sheet: "依頼書",
  mixed: "発注書＋依頼書 (内包)",
};

export const formProfileSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  docKind: formDocKindSchema,
  /** 見分け方の手がかり。⚠ 今は ai に渡しておらず、読み取りには効かない。 */
  hint: z.string().nullable(),
  version: z.number().int(),
  isActive: z.boolean(),
  updatedAt: z.string(),
});
export type FormProfile = z.infer<typeof formProfileSchema>;

/** ノード 1 つぶんの指示文。**無ければ ai の既定が使われる。** */
export const promptSchema = z.object({
  id: z.string(),
  role: promptRoleSchema,
  name: z.string(),
  body: z.string(),
  /**
   * そのノードだけ別のモデルにしたいとき (分類は安いモデルで足りる)。
   * ⚠ **読み出しは緩いまま。** 一覧を絞る前に保存された版が DB に残っていても、
   *   画面が落ちないようにする (保存のほうだけ `MODEL_OPTIONS` に絞ってある)。
   */
  modelName: z.string().nullable(),
  version: z.number().int(),
  isActive: z.boolean(),
  /** 様式に紐づかない共通の指示文は null。 */
  formProfileId: z.string().nullable(),
  updatedAt: z.string(),
});
export type Prompt = z.infer<typeof promptSchema>;

export const formProfileListSchema = z.object({
  profiles: z.array(formProfileSchema),
  prompts: z.array(promptSchema),
});

export const createFormProfileInput = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  docKind: formDocKindSchema,
  hint: z.string().max(2000).nullable().optional(),
});

export const updateFormProfileInput = z.object({
  name: z.string().min(1).max(120).optional(),
  hint: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * 指示文の保存。
 * ⚠⚠ **上書きしない。** 新しい版を作って `is_active` を移す
 *   (`ai_prompts` は版を残す設計。前の版に戻せる)。
 */
export const savePromptInput = z.object({
  role: promptRoleSchema,
  body: z.string().min(1).max(20000),
  /** ⚠⚠ **一覧からしか選ばせない。** 一覧に無い値は ai の契約の parse ごと落ちる。 */
  modelName: z.enum(MODEL_OPTIONS).nullable().optional(),
  /** 様式に紐づけるか (null = すべての様式に効く共通の指示文)。 */
  formProfileId: z.string().nullable().optional(),
});
