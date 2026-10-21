import { and, desc, eq, isNull } from "drizzle-orm";
import { partnerFormProfiles } from "../../partners/db/schema";
import { createDb, type DbStatement, runBatch } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { aiPrompts } from "../db/schema";
import { uuidv7 } from "../lib/uuid-v7";
import type { FormProfile, Prompt, PromptRole } from "../schema";
import { PURPOSE_BY_ROLE } from "./prompt-purpose";

/**
 * ★ 様式と指示文の読み書き。
 *
 * ⚠⚠ **指示文は上書きせず、版を足して `is_active` を移す。** 前の版に戻せることと、
 *   「どの版で読んだか」(`ai_jobs.prompt_id`) を後から追えることが要るため。
 * ⚠ ここに様式ごとの分岐を書かない。**差はデータ (指示文の本文) に置く。**
 */

const ROLE_BY_PURPOSE = Object.fromEntries(
  Object.entries(PURPOSE_BY_ROLE).map(([role, purpose]) => [purpose, role as PromptRole]),
) as Record<string, PromptRole | undefined>;

export async function listFormProfiles(
  env: Bindings,
): Promise<{ profiles: FormProfile[]; prompts: Prompt[] }> {
  const db = createDb(env);

  const profileRows = await db
    .select()
    .from(partnerFormProfiles)
    .orderBy(partnerFormProfiles.code, desc(partnerFormProfiles.version));

  const promptRows = await db
    .select()
    .from(aiPrompts)
    .where(isNull(aiPrompts.deletedAt))
    .orderBy(aiPrompts.purpose, desc(aiPrompts.version));

  return {
    profiles: profileRows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      docKind: row.docKind,
      hint: row.extractionHint,
      version: row.version,
      isActive: row.isActive,
      updatedAt: row.updatedAt.toISOString(),
    })),
    // ⚠ 読み取りに関わる 3 つのノードのものだけを返す (item_resolve などは別の話)。
    prompts: promptRows.flatMap((row) => {
      const role = ROLE_BY_PURPOSE[row.purpose];
      if (!role) return [];
      return [
        {
          id: row.id,
          role,
          name: row.name,
          body: row.body,
          modelName: row.modelName,
          version: row.version,
          isActive: row.isActive,
          formProfileId: row.formProfileId,
          updatedAt: row.updatedAt.toISOString(),
        },
      ];
    }),
  };
}

export class FormProfileConflict extends Error {}

export async function createFormProfile(
  env: Bindings,
  input: { code: string; name: string; docKind: FormProfile["docKind"]; hint?: string | null },
): Promise<{ id: string }> {
  const db = createDb(env);
  const [existing] = await db
    .select({ id: partnerFormProfiles.id })
    .from(partnerFormProfiles)
    .where(eq(partnerFormProfiles.code, input.code))
    .limit(1);
  if (existing) throw new FormProfileConflict("same_code");

  const id = uuidv7();
  const now = new Date();
  await db.insert(partnerFormProfiles).values({
    id,
    // ⚠ 取引先に紐づけない。**様式は取引先をまたいで同じことがある**うえ、
    //   PoC では取引先が読み取りで初めて決まる (partner_id は null 可)。
    partnerId: null,
    code: input.code,
    name: input.name,
    docKind: input.docKind,
    media: "pdf",
    extractionHint: input.hint ?? null,
    version: 1,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

export async function updateFormProfile(
  env: Bindings,
  id: string,
  patch: { name?: string; hint?: string | null; isActive?: boolean },
): Promise<boolean> {
  const db = createDb(env);
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.hint !== undefined) values.extractionHint = patch.hint;
  if (patch.isActive !== undefined) values.isActive = patch.isActive;

  const [row] = await db
    .select({ id: partnerFormProfiles.id })
    .from(partnerFormProfiles)
    .where(eq(partnerFormProfiles.id, id))
    .limit(1);
  if (!row) return false;

  await db.update(partnerFormProfiles).set(values).where(eq(partnerFormProfiles.id, id));
  return true;
}

/**
 * 指示文を保存する。**新しい版を作って使用中にする。**
 *
 * ⚠ 同じ用途・同じ様式の前の版は `is_active` を降ろすだけで**消さない**
 *   (`ai_jobs.prompt_id` から辿れなくなるため)。
 */
export async function savePrompt(
  env: Bindings,
  input: {
    role: PromptRole;
    body: string;
    modelName?: string | null;
    formProfileId?: string | null;
  },
): Promise<{ id: string; version: number }> {
  const db = createDb(env);
  const purpose = PURPOSE_BY_ROLE[input.role];
  const formProfileId = input.formProfileId ?? null;

  const siblings = await db
    .select({ id: aiPrompts.id, version: aiPrompts.version })
    .from(aiPrompts)
    .where(
      and(
        eq(aiPrompts.purpose, purpose),
        formProfileId === null
          ? isNull(aiPrompts.formProfileId)
          : eq(aiPrompts.formProfileId, formProfileId),
      ),
    )
    .orderBy(desc(aiPrompts.version));

  const version = (siblings[0]?.version ?? 0) + 1;
  const id = uuidv7();
  const now = new Date();

  const statements: DbStatement[] = [
    db.insert(aiPrompts).values({
      id,
      purpose,
      name: `${input.role} v${version}`,
      partnerId: null,
      formProfileId,
      version,
      body: input.body,
      modelName: input.modelName ?? null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  // 前の版を降ろす (消さない)。
  for (const sibling of siblings) {
    statements.push(
      db
        .update(aiPrompts)
        .set({ isActive: false, updatedAt: now })
        .where(eq(aiPrompts.id, sibling.id)),
    );
  }
  // ⚠ 版を足すのと前の版を降ろすのは**同じトランザクション**でないと、
  //   使用中が 2 つある瞬間ができる。
  await runBatch(db, statements);

  return { id, version };
}

/**
 * 指示文をやめる (= ai の既定の指示文に戻す)。
 * ⚠ **消さない。** `is_active` を降ろすだけ。
 */
export async function deactivatePrompt(env: Bindings, id: string): Promise<boolean> {
  const db = createDb(env);
  const [row] = await db
    .select({ id: aiPrompts.id })
    .from(aiPrompts)
    .where(eq(aiPrompts.id, id))
    .limit(1);
  if (!row) return false;
  await db
    .update(aiPrompts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(aiPrompts.id, id));
  return true;
}
