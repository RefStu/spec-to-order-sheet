import type { Correction } from "../schema";

/**
 * ★ 人が直した理由の語を、API の形から DB の enum に写す。
 *
 * ⚠⚠ **2 つの語彙がずれている。** API (`../schema.ts` の `correctionErrorKinds`) は
 *   `ocr / mapping / unit / date / missed / fabricated`、
 *   DB (`ai_field_corrections.error_kind`) は
 *   `ocr / mapping / unit / date / missing / hallucination / other`。
 *   **素通しで insert すると 2 値が CHECK 違反になる。**
 * ⚠ **API の zod は変えない。** 案件詳細の画面が送ってくる語をそのまま受けるのが契約。
 *   写すのはここ 1 か所だけにする (2 か所目を作るとずれる)。
 * ⚠ `error_kind` は NOT NULL。理由が付いていなければ `other` に落とす。
 */

/** `ai_field_corrections.error_kind` の取りうる値。 */
export type DbErrorKind =
  "ocr" | "mapping" | "unit" | "date" | "missing" | "hallucination" | "other";

const TO_DB: Record<NonNullable<Correction["errorKind"]>, DbErrorKind> = {
  ocr: "ocr",
  mapping: "mapping",
  unit: "unit",
  date: "date",
  // ⚠ ここ 2 つだけ語が違う。
  missed: "missing",
  fabricated: "hallucination",
};

export function toDbErrorKind(kind: Correction["errorKind"]): DbErrorKind {
  return kind === null || kind === undefined ? "other" : TO_DB[kind];
}
