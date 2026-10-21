import { describe, expect, it } from "vitest";
import { chooseRequestCategory, descriptionPrefix } from "./description-text";

describe("descriptionPrefix", () => {
  it("★ 実物の区分から帳票の語を引く", () => {
    expect(descriptionPrefix("鋳造")).toBe("CASTING");
  });

  it("全角や前後の空白がゆれても引ける (印字そのままが来る)", () => {
    expect(descriptionPrefix("  鋳造 ")).toBe("CASTING");
    expect(descriptionPrefix("鋳 造")).toBe("CASTING");
  });

  it("⚠⚠ 完全一致だけ。前方一致にしない (似た区分と取り違える)", () => {
    expect(descriptionPrefix("鋳造以外")).toBeNull();
    expect(descriptionPrefix("鋳")).toBeNull();
  });

  it("⚠ 一覧に無い区分は語を出さない (発注書の資材名に任せる)", () => {
    expect(descriptionPrefix("ワックス")).toBeNull();
  });

  it("読めなければ null", () => {
    expect(descriptionPrefix(null)).toBeNull();
    expect(descriptionPrefix("  ")).toBeNull();
  });
});

/**
 * ★ 依頼書の区分の**選択肢 3 つ**それぞれの扱い。
 *   ai は選択肢の表記のまま返す (`apps/ai/.../prompts/forms/form1.ts` の `FORM1_REQUEST_CATEGORIES`)。
 * ⚠ `切削` / `Casting/CNC` の接頭辞は対応表に入れていない。
 *   対応表に無い区分なので **Description を空**にする。
 */
describe("区分の選択肢それぞれの扱い", () => {
  it.each([
    ["鋳造", "CASTING"],
    ["切削", null],
    ["Casting/CNC", null],
  ])("%s → %s", (choice, prefix) => {
    expect(descriptionPrefix(chooseRequestCategory(choice))).toBe(prefix);
  });

  /**
   * ⚠⚠ `Casting/CNC` は `/` を含む。②が区切りで割っても
   *   (`Casting` / `CNC`) **どれも対応表に当たらない**ことを固定する。
   */
  it("⚠⚠ Casting/CNC を区切りで割っても誤って当たらない", () => {
    expect(chooseRequestCategory("Casting/CNC")).toBeNull();
    expect(chooseRequestCategory("Casting／CNC")).toBeNull();
  });
});

/**
 * ★★ **選択は「その語に丸が囲われているか」で決まる**（実物で確認した）。
 * ⚠ ai が返すのは「**囲まれている 1 語**」だけ。絞れなければ空にする。
 */
describe("chooseRequestCategory — 丸が囲っている語を選ぶ", () => {
  it("★ モデルが「囲まれている」と決めた語を採る", () => {
    expect(chooseRequestCategory("鋳造")).toBe("鋳造");
  });

  /**
   * ⚠⚠ 実測で、モデルが 2 語を**繋げて**返した実行があった。
   *   そのままだと閉じた集合に当たらず Description が空になる。
   */
  it("⚠⚠ 繋げて返されても、区切りで割って当たる語が 1 つなら採る", () => {
    expect(chooseRequestCategory("鋳造＞切削")).toBe("鋳造");
    expect(chooseRequestCategory("鋳造・切削")).toBe("鋳造");
    expect(chooseRequestCategory("鋳造 / 切削")).toBe("鋳造");
  });

  it("同じ語を 2 度返されても 1 つと数える (重複は詰める)", () => {
    expect(chooseRequestCategory("鋳造・鋳造")).toBe("鋳造");
  });

  it("⚠ どの語も一覧に無ければ空 (資材名などで埋めない)", () => {
    expect(chooseRequestCategory("見たことのない区分")).toBeNull();
    expect(chooseRequestCategory(null)).toBeNull();
    expect(chooseRequestCategory("  ")).toBeNull();
  });

  /** ⚠ 前方一致に戻さない (冒頭の ⚠⚠)。割った語の**完全一致**で見る。 */
  it("⚠⚠ 前方一致にしない", () => {
    expect(chooseRequestCategory("鋳・切")).toBeNull();
    expect(chooseRequestCategory("鋳造以外")).toBeNull();
  });

  /**
   * ⚠⚠ **語ごとの marked の一覧を渡す受け皿は 消した。**
   *   実測 3 回とも①だけで 2 枚とも取れていて、②の出番が無かった。
   *   ⚠ 引数は 1 つ。以前の形は git の履歴にある。
   */
  it("⚠ 引数は「選ばれた 1 語」だけ", () => {
    expect(chooseRequestCategory.length).toBe(1);
  });
});
