import { describe, expect, it } from "vitest";
import { countPages } from "./pdf-pages";

/**
 * ⚠ 実物の PDF は置けない (`assets/` は追跡下に無く、固有名詞も入っている) ので、
 *   **形だけを真似た最小の PDF** を組み立てて確かめる。
 */
function pdfWith(pageRefs: string, extraObjects = ""): Uint8Array {
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      `1 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count 1 >>\nendobj`,
      extraObjects,
      "trailer\n<< /Root 9 0 R >>",
      "%%EOF",
    ].join("\n"),
  );
}

const page = (num: number) => `${num} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj`;

describe("countPages", () => {
  it("Kids の数を数える", () => {
    expect(countPages(pdfWith("2 0 R 3 0 R 4 0 R", [page(2), page(3), page(4)].join("\n")))).toBe(
      3,
    );
  });

  it("入れ子の Pages もたどる", () => {
    const nested = [
      "2 0 obj\n<< /Type /Pages /Kids [4 0 R 5 0 R] >>\nendobj",
      page(3),
      page(4),
      page(5),
    ].join("\n");
    expect(countPages(pdfWith("2 0 R 3 0 R", nested))).toBe(3);
  });

  /**
   * ⚠⚠ **あとに出てくる定義が勝つ。** 実物は追記更新されていて、同じ番号のオブジェクトが
   *   何度も出てくる。古いほうを採ると、消されたページまで数えてしまう。
   */
  it("同じ番号が 2 回出てきたら、あとのほうが勝つ", () => {
    const updated = new Uint8Array([
      ...pdfWith("2 0 R 3 0 R", [page(2), page(3)].join("\n")),
      ...new TextEncoder().encode(
        "\n1 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\n%%EOF\n",
      ),
    ]);
    expect(countPages(updated)).toBe(1);
  });

  it("⚠ 読めない PDF は 0 (呼び手が「進めない」と判断する)", () => {
    expect(countPages(new TextEncoder().encode("not a pdf"))).toBe(0);
    expect(countPages(new Uint8Array())).toBe(0);
  });

  /** ⚠ stream の中身に `12 0 obj` が偶然現れても拾わない (直後が `<<` のものだけ)。 */
  it("stream の中の偽の obj を拾わない", () => {
    const withStream = [page(2), "7 0 obj\nstream\n12 0 obj not a dict\nendstream\nendobj"].join(
      "\n",
    );
    expect(countPages(pdfWith("2 0 R", withStream))).toBe(1);
  });
});
