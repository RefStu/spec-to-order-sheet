/**
 * ★ ORDER SHEET の **Description 欄の頭に付く語**。
 *
 * 実物は `CASTING SV950` の形で、`CASTING` は依頼書の**表題のすぐ下で選ばれている区分**
 * から来ている。
 *
 * ⚠⚠ **閉じた集合の完全一致にする。** `startsWith` にすると
 *   「鋳造」と「鋳造以外」のような区分が誤って一致する。
 * ⚠⚠ **一覧に無い区分は語を出さない** (null)。**欄は空のまま**にする。
 *   以前は発注書の資材名へ落としていたが、資材名は細かい印字で読み違えるので**やめた**
 *   (実測で、紙に無い `SV950 部品X` が Description に入った)。**空のほうが正しい**。
 *   ⚠ 勝手に訳したり、区分名をそのまま英語の頭に置いたりしない。
 * ⚠ **様式ごとの分岐ではない。** 区分の言葉と帳票の語の対応表であって、
 *   様式が増えてもここは増えない (増えるのは区分の種類だけ)。
 */

/** 依頼書の区分 → Description の頭に付く語。 */
const PREFIX_BY_CATEGORY: Record<string, string> = {
  鋳造: "CASTING",
};

/** 全角と空白のゆらぎを詰める (印字そのままが来るため)。 */
function normalize(value: string): string {
  // ⚠ 先に NFKC で全角を半角に寄せてから空白を詰める (全角空白もここで消える)。
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

const NORMALIZED = new Map(
  Object.entries(PREFIX_BY_CATEGORY).map(([key, value]) => [normalize(key), value]),
);

/** 区分の印字から、Description の頭に付く語を引く。無ければ null。 */
export function descriptionPrefix(requestCategoryText: string | null): string | null {
  const text = requestCategoryText?.trim() ?? "";
  if (text.length === 0) return null;
  return NORMALIZED.get(normalize(text)) ?? null;
}

/** 区分の行の区切り記号。⚠ **語の切れ目**であって、語の一部ではない。 */
const CATEGORY_SEPARATORS = /[・､、,/／>＞|｜\s]+/u;

/**
 * ★★ 依頼書の区分から、**選ばれている語 1 つ**を決める。
 *
 * ⚠⚠ **選択は「その語に丸が囲われているか」で決まる** (実物で確認した)。
 *   ai は「**囲まれている 1 語**」(`selectedText`) だけを返す。
 *   ⚠ ai は紙を書き写さず**様式の選択肢の表記のまま**返す
 *   (様式 1 では `鋳造` / `切削` / `Casting/CNC`)。
 * ⚠ どれにも当たらなければ **null** (欄は空のまま。資材名などで埋めない)。
 *
 * ⚠⚠ **語ごとの marked の一覧 (`requestCategoryChoices`) は やめた。**
 *   それを使う受け皿②(「線が掛かった語がちょうど 1 つならそれ」) も一緒に消した。
 *   実測 3 回とも①だけで**2 枚とも**取れていて (confidence 85〜90)、②の出番が無かった。
 *   ⚠ **戻すなら、まず「①だけでは足りなかった」実測を取ること**
 *   (以前の形は git の履歴にある)。
 *
 * ⚠⚠ `fallbackText` を**区切りで割って完全一致**を見る②は**残してある**。モデルが
 *   `鋳造＞切削` のように**語をつなげて返した**実行があったため (実測)。
 *   **前方一致にはしない。** 割った語の**完全一致**で、当たる語がちょうど 1 つのときだけ採る。
 */
export function chooseRequestCategory(selectedText: string | null): string | null {
  // ① **モデルが「囲まれている」と決めた 1 語**が一覧に当たれば、それを採る。
  const text = selectedText?.trim() ?? "";
  if (text.length === 0) return null;
  if (descriptionPrefix(text) !== null) return text;

  // ② ⚠ 語をつなげて返されたときだけ、区切りで割って**当たる語が 1 つ**なら採る。
  const words = text.split(CATEGORY_SEPARATORS).filter((word) => word.trim().length > 0);
  const hits = [...new Set(words.filter((word) => descriptionPrefix(word) !== null))];
  return hits.length === 1 ? hits[0]! : null;
}
