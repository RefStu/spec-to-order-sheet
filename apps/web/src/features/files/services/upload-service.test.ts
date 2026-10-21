import { describe, expect, it } from "vitest";
import { parsePhotoStorageKey, photoStorageKey, photoStorageKeyPrefix } from "./upload-service";

/**
 * ★ 代表の図の保存先の鍵。**書く側 (consumer) と引く側 (generator) の唯一の橋**
 *   なので、形を固定する。
 *
 * ⚠⚠ **1 枚目は接尾辞なし。** 既に R2 と `files` に入っている鍵がこの形なので、
 *   変えると**前の読み取りで切り出した絵が全部迷子になる**。
 * ⚠ `files` には「どの帳票から来たか」の列が無い。鍵だけが出どころを知っている。
 */
describe("代表の図の鍵", () => {
  // ⚠ 実物の `revision_requests.id` は uuidv7 (16 進と `-` だけ)。
  const id = "0192f0c2-2f9c-7b3f-9a1e-6a5c8d4e1b77";

  it("⚠⚠ 1 枚目は接尾辞なし (既存の鍵をそのまま保つ)", () => {
    expect(photoStorageKey(id)).toBe(`photos/spec/${id}.jpg`);
    expect(photoStorageKey(id, 0)).toBe(photoStorageKey(id));
  });

  it("2 枚目からは何枚目かが付く", () => {
    expect(photoStorageKey(id, 1)).toBe(`photos/spec/${id}_1.jpg`);
    expect(photoStorageKey(id, 3)).toBe(`photos/spec/${id}_3.jpg`);
  });

  it("接頭辞は鍵と同じ式から作る (generator が like で引く)", () => {
    expect(photoStorageKey(id, 2).startsWith(photoStorageKeyPrefix(id))).toBe(true);
  });

  it("★ 鍵は (依頼書, 何枚目) に開いて往復する", () => {
    for (const index of [0, 1, 2, 3]) {
      expect(parsePhotoStorageKey(photoStorageKey(id, index))).toEqual({
        revisionRequestId: id,
        pictureIndex: index,
      });
    }
  });

  /**
   * ⚠⚠ 区切りが `-` だと `<id>-1.jpg` を「id が `<id>-1` の 1 枚目」とも読めてしまう
   *   (uuid は `-` を含む)。`_` は id に現れないので、開き方が 1 通りに決まる。
   */
  it("⚠ uuid の `-` と取り違えない", () => {
    expect(parsePhotoStorageKey(`photos/spec/${id}.jpg`)?.pictureIndex).toBe(0);
    expect(parsePhotoStorageKey(`photos/spec/${id}_1.jpg`)?.revisionRequestId).toBe(id);
  });

  it("形の違う鍵は null (接頭辞が別のものに当たっても捨てられる)", () => {
    expect(parsePhotoStorageKey(`documents/inbound/${id}.pdf`)).toBeNull();
    expect(parsePhotoStorageKey(`photos/spec/${id}/2.jpg`)).toBeNull();
    expect(parsePhotoStorageKey(`photos/spec/${id}.png`)).toBeNull();
  });
});
