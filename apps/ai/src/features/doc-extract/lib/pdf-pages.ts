/**
 * PDF に何ページあるかを数えるだけの部品。
 *
 * ⚠⚠ **描画はしない。** ページを絵にするのは `lib/page-images.ts`(`pdftoppm`) の仕事。
 *   ここが要るのは「分類に何ページ渡すか」と「分類が言ったページ番号が範囲の中か」を
 *   決めるためだけ。そのために外の二進をもう一度呼ぶ必要は無いので、
 *   **PDF のページの木を直接たどる。**
 * ⚠ ここは `apps/ai` なので `node:` を使ってよい (禁止は `apps/web/src` だけ)。
 */

interface PdfObject {
  /** `<<` から `stream` または `endobj` の手前まで。 */
  dict: string;
}

/**
 * すべての間接オブジェクトを拾う。
 *
 * ⚠⚠ **あとに出てくる定義が勝つ。** 実物の PDF は追記更新 (incremental update) されていて、
 *   同じ番号のオブジェクトが何度も出てくる。**最後のものが現在の中身。**
 * ⚠ stream の中身に `12 0 obj` という並びが偶然現れることがあるので、
 *   直後が `<<` で始まるものだけを受け付ける。
 */
function readObjects(text: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(?:^|[\r\n\s])(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const after = re.lastIndex;
    const dictAt = text.indexOf("<<", after);
    if (dictAt === -1 || dictAt - after > 8) continue;

    const streamMark = text.indexOf("stream", dictAt);
    const endObj = text.indexOf("endobj", dictAt);
    const hasStream = streamMark !== -1 && (endObj === -1 || streamMark < endObj);
    const dictEnd = hasStream ? streamMark : endObj === -1 ? text.length : endObj;

    objects.set(Number(m[1]), { dict: text.slice(dictAt, dictEnd) });
  }
  return objects;
}

/** `/Kids [1 0 R 2 0 R]` の参照先を順番に並べる (Pages が入れ子のこともある)。 */
function collectPages(objects: Map<number, PdfObject>, root: number, seen: Set<number>): number[] {
  if (seen.has(root)) return [];
  seen.add(root);
  const object = objects.get(root);
  if (!object) return [];

  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(object.dict);
  if (!kids) return /\/Type\s*\/Page\b/.test(object.dict) ? [root] : [];

  const pages: number[] = [];
  for (const ref of kids[1]!.matchAll(/(\d+)\s+\d+\s+R/g)) {
    pages.push(...collectPages(objects, Number(ref[1]), seen));
  }
  return pages;
}

/** ページの一覧。`/Type /Pages` の根から辿る。 */
function pageNumbers(objects: Map<number, PdfObject>): number[] {
  for (const [num, object] of objects) {
    if (/\/Type\s*\/Pages\b/.test(object.dict) && /\/Kids\s*\[/.test(object.dict)) {
      const pages = collectPages(objects, num, new Set());
      if (pages.length > 0) return pages;
    }
  }
  return [];
}

/**
 * PDF に何ページあるか。
 * ⚠ 数えられなければ 0。**呼び手が 0 を「読めない PDF」として扱うこと** (0 ページで進めない)。
 */
export function countPages(pdf: Uint8Array): number {
  // latin1 は 1 バイト = 1 文字なので、文字の位置とバイトの位置が一致する。
  return pageNumbers(readObjects(Buffer.from(pdf).toString("latin1"))).length;
}
