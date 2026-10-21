import { describe, expect, it } from "vitest";
import type { DocumentClassification } from "../contract";
import {
  extractNodesOf,
  noteNodeLabel,
  pictureNodeKey,
  pictureNodeLabel,
  specSheetLabel,
} from "./progress";

/**
 * ⚠⚠ **鍵がずれると、画面に「待機」のまま終わらないノードが残る。**
 *
 *   分類の終わりに `extractNodesOf()` の一覧を `pending` として流し
 *   (`steps/classify.ts`)、実際に走るノードが同じ鍵で `running` / `succeeded` を流す
 *   (`steps/extract.ts` と `steps/locate-pictures.ts`)。**両者が同じ鍵であること**が
 *   このファイルの担保するもの。⚠ web は鍵を `z.string()` で受けるので、
 *   **ずれても型検査では落ちない。**
 */

function parts(
  roles: DocumentClassification["parts"][number]["role"][],
): DocumentClassification["parts"] {
  return roles.map((role, index) => ({ role, pages: [index + 1], confidence: 90 }));
}

const keys = (p: DocumentClassification["parts"]) => extractNodesOf(p).map((node) => node.node);

describe("extractNodesOf", () => {
  /** ⚠⚠ 下部のメモのノードは**画面の進捗に出さない**。 */
  it("発注書 1 通 + 依頼書 2 枚 なら po / spec-n / pic-n が並ぶ (メモは出ない)", () => {
    expect(keys(parts(["purchase_order", "spec_sheet", "spec_sheet"]))).toEqual([
      "po",
      "spec-1",
      "spec-2",
      "pic-1",
      "pic-2",
    ]);
  });

  /** ⚠ 発注書は**複数あっても 1 通目だけ**を読む (`steps/extract.ts` と同じ絞り方)。 */
  it("発注書が 2 通あっても po は 1 つ", () => {
    expect(keys(parts(["purchase_order", "purchase_order", "spec_sheet"]))).toEqual([
      "po",
      "spec-1",
      "pic-1",
    ]);
  });

  it("依頼書が 0 枚なら spec / pic は出ない", () => {
    expect(keys(parts(["purchase_order"]))).toEqual(["po"]);
  });

  it("発注書が無ければ po は出ない", () => {
    expect(keys(parts(["spec_sheet"]))).toEqual(["spec-1", "pic-1"]);
  });

  /** ⚠ `unknown` のページは読まない (読めないものを読んだふりにしない)。 */
  it("unknown は数に入らない", () => {
    expect(keys(parts(["unknown", "unknown"]))).toEqual([]);
  });

  /** ⚠ 鍵は**ローマ字**、label だけが表示用。鍵に日本語を混ぜると別物になる。 */
  it("鍵はローマ字で、日本語は label にだけ出る", () => {
    const nodes = extractNodesOf(parts(["purchase_order", "spec_sheet"]));
    for (const node of nodes) {
      expect(node.node).toMatch(/^[a-z0-9-]+$/u);
      expect(node.label.length).toBeGreaterThan(0);
    }
    expect(nodes.map((node) => node.label)).toEqual([
      "発注書",
      specSheetLabel(0),
      pictureNodeLabel(0),
    ]);
  });

  /** ⚠ 1 始まり (画面の「依頼書 1 枚目」と揃える)。 */
  it("pic の鍵と label は 1 始まりで依頼書と対応する", () => {
    expect(pictureNodeKey(0)).toBe("pic-1");
    expect(pictureNodeLabel(1)).toContain(specSheetLabel(1));
  });

  /** ⚠ メモの呼び名は失敗の名指しにだけ使う (進捗には出さない)。 */
  it("note の呼び名は 1 始まりで依頼書と対応する", () => {
    expect(noteNodeLabel(1)).toContain(specSheetLabel(1));
  });
});
