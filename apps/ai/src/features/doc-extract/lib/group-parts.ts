import type { ClassifiedPage, DocumentClassification } from "../contract";

/**
 * ★★ ページの並びから**読み取りの単位 (部品)** を作る。**ここが読み取り回数の正。**
 *
 * ⚠⚠ **モデルに数えさせない。** 読み取りが何回走るかは `parts.length` で決まるのに、
 *   まとめ方をモデルに任せると、**2 枚の依頼書を 1 要素にまとめた実行で読み取りが
 *   1 回しか走らず、落とした 1 枚に誰も気づけない**。モデルに聞くのは
 *   「この紙は何か」と「新しい 1 枚の始まりか」だけで、**数えるのはここ**。
 *   流れはコードが持つ。分類が「依頼書が 2 枚」と言えば、読み取りは必ず 2 回。
 *
 * まとめ方:
 * - `purchase_order` … **連続するページを 1 つにまとめる** (発注書は 1 通で複数ページありうる)
 * - `spec_sheet` … `startsNewSheet` が真のところで区切る。偽の続きは同じ枚に足す
 * - `other` … **部品にしない** (読まない)
 */

type Part = DocumentClassification["parts"][number];

/** ⚠ 部品の確信度は、その部品に入ったページの**いちばん低い値**。弱い 1 枚が全体を弱くする。 */
function weakest(pages: readonly ClassifiedPage[]): number {
  return pages.reduce((min, page) => Math.min(min, page.confidence), 100);
}

export function partsFromPages(pages: readonly ClassifiedPage[]): Part[] {
  // ⚠ モデルは順序を崩して返すことがある。**必ず昇順に並べてから**境界を見る。
  const sorted = [...pages].sort((a, b) => a.page - b.page);

  const parts: Part[] = [];
  let current: { role: Part["role"]; pages: ClassifiedPage[] } | null = null;

  const flush = () => {
    if (!current) return;
    parts.push({
      role: current.role,
      pages: current.pages.map((page) => page.page),
      confidence: weakest(current.pages),
    });
    current = null;
  };

  for (const page of sorted) {
    if (page.docType === "other") {
      // ⚠ 読まない紙は部品にしない。連続も切る (間に挟まれば別の部品になる)。
      flush();
      continue;
    }

    /*
     * ⚠⚠ **依頼書は「新しい 1 枚の始まり」で区切る。**
     *   ただし **最初の 1 枚だけは `startsNewSheet` を見ない** —
     *   モデルが全部 false を返しても 0 枚にならないようにするため
     *   (安全側は「多めに数える」ではなく「**取りこぼさない**」)。
     */
    const startsNew =
      page.docType === "spec_sheet" && current?.role === "spec_sheet" && page.startsNewSheet;

    if (!current || current.role !== page.docType || startsNew) {
      flush();
      current = { role: page.docType, pages: [] };
    }
    current.pages.push(page);
  }
  flush();

  return parts;
}
