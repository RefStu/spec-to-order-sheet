import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import type { ExtractedSpecSheet } from "../../ai-review/lib/ai-contract";
import { createDb } from "../../../shared/db";
import { buildRevisionRequestWrites } from "./spec-writer";

/**
 * ★ 依頼書の**下部のメモ** (**将来は消す**) の書き込み。
 *
 * ⚠ 文は**組み立てるだけ**で実行しない関数なので、D1 は要らない (`toSQL()` で中身を見る)。
 * ⚠ 値は架空 (実物の値を書かない)。
 */
const db = createDb({ DB: {} as D1Database });

const empty = { value: null, quote: null, page: null, confidence: 0 };
const field = (value: string) => ({ value, quote: value, page: 2, confidence: 80 });

function sheet(specNote: ExtractedSpecSheet["specNote"]): ExtractedSpecSheet {
  return {
    specNo: field("2099-12-S002"),
    productName: empty,
    purityText: empty,
    requestCategoryText: empty,
    pictures: [],
    specNote,
  };
}

function build(extraction: ExtractedSpecSheet) {
  return buildRevisionRequestWrites(db, {
    poDocumentId: "pd-1",
    caseId: "case-1",
    aiJobId: "job-1",
    partnerId: "partner-1",
    extractions: [extraction],
    now: new Date("2026-09-24T00:00:00Z"),
  });
}

/** `revision_request_specs` の insert を 列 -> 値 に開く。 */
function specColumns(statements: ReturnType<typeof build>["statements"]) {
  for (const statement of statements) {
    const { sql, params } = (statement as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
    const parsed = /insert into "revision_request_specs" \(([^)]*)\) values \(([^)]*)\)/iu.exec(sql);
    if (!parsed) continue;
    const columns = parsed[1]!.split(",").map((name) => name.trim().replaceAll('"', ""));
    const slots = parsed[2]!.split(",").map((slot) => slot.trim());
    let next = 0;
    return Object.fromEntries(
      columns.map((name, index) => [name, slots[index] === "?" ? params[next++] : null]),
    );
  }
  throw new Error("revision_request_specs の insert がありません");
}

describe("buildRevisionRequestWrites — 下部のメモ", () => {
  it("★ メモの 5 欄を note_* の列に印字そのまま書き、欄の記録も積む", () => {
    const built = build(
      sheet({
        sizeText: field("12"),
        stoneText: field("石の指定"),
        description2: field("仕上げの指定"),
        description3: empty,
        description4: field("ロゴの指定"),
      }),
    );

    const columns = specColumns(built.statements);
    expect(columns.note_size_text).toBe("12");
    expect(columns.note_stone_text).toBe("石の指定");
    expect(columns.note_description2).toBe("仕上げの指定");
    expect(columns.note_description3).toBeNull();
    expect(columns.note_description4).toBe("ロゴの指定");

    const noteFields = built.fields.filter((f) => f.targetColumn.startsWith("note_"));
    // ⚠ 印字が無かった欄 (description3) は記録を作らない (正答率の分母を水増ししない)。
    expect(noteFields.map((f) => f.targetColumn).sort()).toEqual([
      "note_description2",
      "note_description4",
      "note_size_text",
      "note_stone_text",
    ]);
  });

  it("⚠ ノードが走っていない (specNote が null) なら列は空で、記録も積まない", () => {
    const built = build(sheet(null));

    const columns = specColumns(built.statements);
    for (const column of [
      "note_size_text",
      "note_stone_text",
      "note_description2",
      "note_description3",
      "note_description4",
    ]) {
      expect(columns[column] ?? null).toBeNull();
    }
    expect(built.fields.some((f) => f.targetColumn.startsWith("note_"))).toBe(false);
  });
});
