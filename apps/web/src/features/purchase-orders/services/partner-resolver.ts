import { eq, or } from "drizzle-orm";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import { partners } from "../../partners/db/schema";
import { createDb } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";

/**
 * 発注書から読んだ取引先名を `partners` の行に引き当てる。
 *
 * ⚠ **`purchase_orders.partner_id` と `order_sheets.partner_id` は NOT NULL。**
 *   引き当てられないと 1 行も書けずに止まるので、見つからなければ行を起こす。
 * ⚠ **AI の出力からマスタを増やすのは本来おかしい。** PoC に取引先マスタの登録画面が
 *   無いための迂回で、起こした行は `is_active = false` にして人の確認に回す。
 *   (運用では取引先は先に登録されている前提。ここは運用でふさぐ)
 */
export interface ResolvedPartner {
  partnerId: string;
  name: string;
  /** マスタに無かったので起こした = 人が確認する必要がある。 */
  created: boolean;
}

export async function resolvePartner(
  env: Bindings,
  customerName: string | null,
): Promise<ResolvedPartner> {
  const db = createDb(env);
  const name = customerName?.trim() ?? "";

  if (name.length > 0) {
    const [found] = await db
      .select({ id: partners.id, name: partners.name })
      .from(partners)
      .where(or(eq(partners.name, name), eq(partners.nameEn, name), eq(partners.shortName, name)))
      .limit(1);
    if (found) return { partnerId: found.id, name: found.name, created: false };
  }

  // 読み取れなかったときの置き場所も要る (取引先が空だと発注書の行が作れない)。
  const label = name.length > 0 ? name : "取引先不明";
  const partnerId = uuidv7();
  await db.insert(partners).values({
    id: partnerId,
    // ⚠ code は UNIQUE。マスタの採番規則を知らないので、行 ID から作る。
    code: `AUTO-${partnerId.slice(0, 8)}`,
    name: label,
    shortName: label.slice(0, 20),
    // 人が確認するまで「取引中」にしない。
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { partnerId, name: label, created: true };
}
