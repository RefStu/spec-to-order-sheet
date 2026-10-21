import { describe, expect, it } from "vitest";
import { correctionErrorKinds } from "../schema";
import { toDbErrorKind } from "./correction-kind";

/**
 * ⚠⚠ **API の 6 値がすべて DB の enum に落ちることを固定する。**
 *   落ちないと `ai_field_corrections` の insert が CHECK 違反で落ち、
 *   **正答率の分母が永久に空のまま**になる。
 */
const DB_KINDS = ["ocr", "mapping", "unit", "date", "missing", "hallucination", "other"];

describe("toDbErrorKind", () => {
  it("API の 6 値がすべて DB の enum に収まる", () => {
    for (const kind of correctionErrorKinds) {
      expect(DB_KINDS).toContain(toDbErrorKind(kind));
    }
  });

  it("語が違う 2 つを写す", () => {
    expect(toDbErrorKind("missed")).toBe("missing");
    expect(toDbErrorKind("fabricated")).toBe("hallucination");
  });

  it("同じ語はそのまま", () => {
    expect(toDbErrorKind("ocr")).toBe("ocr");
    expect(toDbErrorKind("date")).toBe("date");
  });

  it("理由が無ければ other (error_kind は NOT NULL)", () => {
    expect(toDbErrorKind(null)).toBe("other");
  });
});
