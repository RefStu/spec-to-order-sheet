import type { D1Database } from "@cloudflare/workers-types";

/**
 * ⚠⚠ **ローカルで画面を確かめるためだけの架空データ。**
 *   取り込みが動いたら消す。
 * ⚠ **固有名詞を入れない。** 取引先は「顧客A」、品番・発注番号はすべて架空のコード。
 */
const PARTNERS = [
  { id: "seed-partner-a", code: "PT-A", name: "顧客A", shortName: "A" },
  { id: "seed-partner-b", code: "PT-B", name: "顧客B", shortName: "B" },
];

const CASES = [
  { id: "seed-case-1", caseNo: "CS-0001", specNo: "SPC-0001", partnerId: "seed-partner-a" },
  { id: "seed-case-2", caseNo: "CS-0002", specNo: "SPC-0002", partnerId: "seed-partner-a" },
  { id: "seed-case-3", caseNo: "CS-0003", specNo: "SPC-0003", partnerId: "seed-partner-b" },
];

export async function seedDemoCases(db: D1Database): Promise<{ inserted: number }> {
  const now = Date.now();

  const statements = [
    ...PARTNERS.map((partner) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO partners (id, code, name, short_name, country, tax_mode,
             po_no_label, is_active, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'JP', 'excluded', 'customer_po', 1, ?5, ?5)`,
        )
        .bind(partner.id, partner.code, partner.name, partner.shortName, now),
    ),
    ...CASES.map((row) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO cases (id, case_no, partner_id, spec_no, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?5)`,
        )
        .bind(row.id, row.caseNo, row.partnerId, row.specNo, now),
    ),
  ];

  await db.batch(statements);
  return { inserted: CASES.length };
}
