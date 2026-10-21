import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMON_ROLE, COMMON_RULES, PROMPT_SECTIONS } from "./common";
import { FORM1_REQUEST_CATEGORIES, FORM1_SPEC_NOTES } from "./forms/form1";
import { FORM_CODES, formNameOf, knownFormCode, promptFor, type PromptRole } from "./index";
import { purchaseOrderPrompt } from "./purchase-order";
import { specSheetPrompt } from "./spec-sheet";
import { specNoteAnswer, specSheetFieldsAnswer } from "../contract";

/**
 * ★ 禁止語 (取引先の名前・略号・実在の番号)。一覧そのものが取引先を名指しするので
 *   ソースには書かず、手元に置いた `assets/banned-terms.txt` (1 行 1 語) から読む。
 *   ⚠ このファイルはリポジトリに含まない。手元に置いたときだけ検査し、無ければ空 (= そのテストは飛ばす)。
 */
const BANNED_TERMS_PATH = "assets/banned-terms.txt";
const bannedTermsUrl = new URL(`../../../../../../${BANNED_TERMS_PATH}`, import.meta.url);
const BANNED_TERMS = existsSync(bannedTermsUrl)
  ? readFileSync(bannedTermsUrl, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  : [];

/**
 * ⚠⚠ **文面のリテラル一致を増やさないこと。**
 *   以前の `instructions.test.ts` は 20 か所を丸ごと一致で固定していて、
 *   改行や語順を変えるだけで落ちた。ここでは 3 層に分けてある:
 *   (a) 構造 … 文面を書き換える自由を残す
 *   (b) 実測で見つかった穴 … **8 個だけ**を、言い回しに幅を持たせた形で固定する
 *   (c) 禁止 … 戻ってはいけないもの
 */

const ROLES: PromptRole[] = [
  "classify",
  "purchase_order",
  "spec_sheet",
  "picture_location",
  "spec_note",
  "link",
];

/** 様式を指定しないときの全文面 (b と c はこれを見る)。 */
const ALL = Object.fromEntries(ROLES.map((role) => [role, promptFor(role, null)])) as Record<
  PromptRole,
  string
>;

// ── (a) 構造 ────────────────────────────────────────────────────────────────

describe("プロンプトの組み立て", () => {
  /**
   * ⚠⚠ **節の順は全役割で同じ。** 以前は `COMMON_RULES` で始めていたが、
   *   **役割を名乗った直後にルールが来ていて「何をしてほしいのか」が後ろだった**ので、
   *   `# 役割 / # 概要 / # ルール / # 取り出すもの / # 出力形式` に組み直した。
   *   並びを持つのは `prompts/layout.ts` の `buildPrompt()` だけ。
   */
  it.each(ROLES)("%s は # 役割 で始まる", (role) => {
    expect(promptFor(role, null).startsWith(`${PROMPT_SECTIONS[0]}\n\n${COMMON_ROLE}`)).toBe(true);
  });

  /** ⚠ 共通の 6 条は**どの役割にも**入る (下の (b) の固定がこれに乗っている)。 */
  it.each(ROLES)("%s に共通の 6 条がそのまま入る", (role) => {
    expect(promptFor(role, null)).toContain(COMMON_RULES);
  });

  it.each(ROLES)("%s の節は決めた順に並ぶ", (role) => {
    const headings = promptFor(role, null)
      .split("\n")
      .filter((line) => line.startsWith("# "));
    // ⚠ `slice` なのは、様式の差分が **6 つ目の `#`**(`# この様式の紙面`) を足すため。
    expect(headings.slice(0, PROMPT_SECTIONS.length)).toEqual([...PROMPT_SECTIONS]);
  });

  /**
   * ⚠⚠ **様式を増やすときに触るのは表と `forms/<code>.ts` の 2 つだけ**、を固定する。
   *   `steps/` や `lib/` に様式の分岐が生えたら、この形は崩れている。
   */
  it("表に載っている様式はすべて名前を引ける", () => {
    expect(FORM_CODES.length).toBeGreaterThan(0);
    for (const code of FORM_CODES) {
      expect(knownFormCode(code)).toBe(code);
      expect(formNameOf(code)).toBeTruthy();
    }
  });

  it("分類のプロンプトに表の全 code と名前が出る (一覧とプロンプトがずれない)", () => {
    const classify = promptFor("classify", null);
    for (const code of FORM_CODES) {
      expect(classify).toContain(code);
      expect(classify).toContain(formNameOf(code));
    }
  });

  /** ⚠⚠ 様式が分からなくても**止めない**。共通の本文だけで読む。 */
  it("一覧に無い様式は既定の経路に落ちる (例外にしない)", () => {
    expect(knownFormCode("NOPE")).toBeNull();
    expect(formNameOf("NOPE")).toBeNull();
    expect(promptFor("spec_sheet", "NOPE")).toBe(promptFor("spec_sheet", null));
    expect(promptFor("purchase_order", "NOPE")).toBe(promptFor("purchase_order", null));
    expect(promptFor("picture_location", "NOPE")).toBe(promptFor("picture_location", null));
    expect(promptFor("spec_note", "NOPE")).toBe(promptFor("spec_note", null));
  });

  /**
   * ⚠⚠ **契約と文面をずらさない。** 欄の名前が変わったのに文面が古いままだと、
   *   モデルは「無い欄」を埋めようとして**欄ごと落とす**。ここは (b) の実測の穴では
   *   なく**構造**の固定なので、欄を増やしたらこの一覧も増やす。
   */
  it("⚠⚠ 依頼書の文面が契約の欄の名前を表の行として呼ぶ", () => {
    // ⚠ 手で並べず **schema から引く**。契約に欄を足したら、文面にも足さないと落ちる。
    const rows = new Set(
      [...ALL.spec_sheet.matchAll(/^\| ([A-Za-z][\w.[\]]*) /gmu)].map((match) => match[1]),
    );
    for (const name of Object.keys(specSheetFieldsAnswer.shape)) {
      expect(rows).toContain(name);
    }
    // ⚠⚠ **図の場所はこのノードでは聞かない** (`picture_location` の担当)。
    expect(ALL.spec_sheet).not.toContain("pictures");
  });

  /** ⚠⚠ 下部のメモのノードの文面が、契約の欄の名前をすべて表の行として呼ぶ。 */
  it("⚠⚠ 下部のメモの文面が契約の欄の名前を表の行として呼ぶ", () => {
    const rows = new Set(
      [...ALL.spec_note.matchAll(/^\| ([A-Za-z][\w.[\]]*) /gmu)].map((match) => match[1]),
    );
    for (const name of Object.keys(specNoteAnswer.shape)) {
      expect(rows).toContain(name);
    }
    // ⚠⚠ 欄の読み取りのノードにはメモを混ぜない (区分が再び落ちうる)。
    for (const label of ["Description#2", "stoneText", "specNote"]) {
      expect(ALL.spec_sheet).not.toContain(label);
    }
    // ⚠ 5 つのラベルを名指しする (ラベル名は値ではないので書いてよい)。
    for (const label of ["Size", "STONE", "Description#2", "Description#3", "Description#4"]) {
      expect(ALL.spec_note).toContain(label);
    }
  });

  /** ⚠⚠ 場所のノードは**座標だけ**を聞く (欄の読み取りを混ぜない)。 */
  it("⚠⚠ 場所のノードの文面が契約の欄の名前を呼ぶ", () => {
    expect(ALL.picture_location).toContain("pictures");
    expect(ALL.picture_location).toContain("labelQuote");
    // 単数だったころの名前が残っていない (契約には もう無い)。
    expect(ALL.picture_location).not.toContain("pictureBox");
    // ⚠ 欄の読み取りを混ぜ戻さない。
    expect(ALL.picture_location).not.toContain("purityText");
    expect(ALL.picture_location).not.toContain("requestCategory");
  });

  /**
   * ⚠⚠ **区分は「書き写す」のではなく「様式の選択肢から選ぶ」**。
   *   選択肢は様式の知識なので `forms/<code>.ts` にだけ置き、本文には書かない
   *   (様式が増えたときに本文が膨らまないように)。
   */
  it("⚠⚠ 区分は様式の注意書きに挙げた選択肢から、その表記のまま選ばせる", () => {
    // 本文は「注意書きの選択肢から、表記のまま」と言い、書き写しを止める。
    expect(ALL.spec_sheet).toMatch(/注意書きに挙げた選択肢/);
    expect(ALL.spec_sheet).toMatch(/注意書きの表記のまま/);
    expect(ALL.spec_sheet).toMatch(/書き写さない/);
    expect(ALL.spec_sheet).toMatch(/丸が無ければ null/);
    // ⚠ 選択肢は本文に漏らさない。様式①のときだけ、注意書きから全部が入る。
    const form1 = promptFor("spec_sheet", "FORM1");
    for (const choice of FORM1_REQUEST_CATEGORIES) {
      expect(ALL.spec_sheet).not.toContain(choice);
      expect(FORM1_SPEC_NOTES).toContain(`\`${choice}\``);
      expect(form1).toContain(choice);
    }
  });

  /**
   * 様式ごとの差分は**本文の末尾に足す**形。
   * ⚠ 様式① は紙面の位置を持つ (`forms/form1.ts`)。まだ差分の無い様式もあるので、
   *   **空でも壊れないこと**も併せて固定する。
   */
  it("様式ごとの注意書きは末尾に足される", () => {
    expect(purchaseOrderPrompt("★この様式だけの注意").endsWith("★この様式だけの注意")).toBe(true);
    expect(specSheetPrompt("★この様式だけの注意").endsWith("★この様式だけの注意")).toBe(true);
    // 空の差分は何も足さない (末尾に空行を作らない)。
    expect(purchaseOrderPrompt("")).toBe(purchaseOrderPrompt());
    expect(specSheetPrompt("   ")).toBe(specSheetPrompt());
  });
});

// ── (b) 実測で見つかった穴 ──────────────────────────────────────────────────────

describe("⚠ 実測で見つかった穴の固定", () => {
  /** ⚠ 「手書きも読んでよい」に戻ると、数量やサイズを手書きのメモから拾い始める。 */
  it.each(ROLES)("%s は手書きを読まないと言い切る", (role) => {
    expect(ALL[role]).toMatch(/手書き[^。]*読みませ/);
  });

  /** ⚠ 実測: 2 枚目の依頼書の石の表が空なのに、1 枚目と同じ石が返ってきた。 */
  it.each(ROLES)("%s は他のページから値を借りるなと言う", (role) => {
    expect(ALL[role]).toContain("他のページ");
    expect(ALL[role]).toMatch(/借り|写す/);
  });

  /** ⚠ ここが崩れると `ai_extraction_fields.page_no` から原本に戻れない。 */
  it.each(ROLES)("%s は page が PDF 全体の通し番号だと言う", (role) => {
    expect(ALL[role]).toContain("PDF 全体の通し番号");
  });

  /**
   * ⚠⚠ 区分は ORDER SHEET の Description の頭の語になる。
   *   1 本の文字列で返させていたころ、モデルが 2 語を**繋げて**返して Description が空になった
   *   (web の `chooseRequestCategory` の②が、いまもその受け皿として残っている)。
   *
   * ⚠⚠ **語ごとの `marked` の一覧 (`requestCategoryChoices`) はやめた。**
   *   実測 3 回とも `requestCategoryText` だけで**2 枚とも**取れた (confidence 85〜90)。
   *   ⚠ **つなげさせない文は残す**（消すと Description が空に戻る失敗が戻る）。
   */
  it("⚠⚠ 区分は 1 つだけを返させ、つなげさせない", () => {
    // ⚠ 途中で「語」を「選択肢」と言い換えた (どちらの言い方でも通す)。
    expect(ALL.spec_sheet).toMatch(/(語|選択肢)をつなげて 1 つにしないでください/);
    expect(ALL.spec_sheet).toMatch(/印が掛かっている(選択肢 )?1 (語|つ)だけ/);
    // ⚠ 語ごとの marked はもう聞かない (契約に欄が無い)。
    expect(ALL.spec_sheet).not.toContain("marked");
  });

  /** ⚠⚠ 丸の線の端は隣の語にはみ出す。**囲まれている語を 1 つに決めさせる。** */
  it("⚠⚠ 囲まれている語を 1 つに決めさせる", () => {
    expect(ALL.spec_sheet).toMatch(/囲まれて[^。]*1 つ/);
  });

  /** ⚠ 実測: 「タイトル」欄を資材名として拾い、Description と STONE が同時に壊れた。 */
  it("⚠ 資材名として拾ってはいけないものを名指しする", () => {
    expect(ALL.purchase_order).toMatch(/資材名では(あり)?ませ/);
    expect(ALL.purchase_order).toContain("改行でつないで");
  });

  /**
   * ⚠⚠ **代表の図は「いちばん左上の 1 つ」「絵の部分だけ」の 2 つだけを固定する。**
   *
   * ⚠⚠ **大きさを指示する文は全部落とした。** 切り出した絵に
   *   隣の図が写る / 絵が見切れるのは注意書きが多すぎるため、という判断。
   *   そのため、ここで固定していた次の 10 個の言い回しも**一緒に外した**:
   *   `枠は小さい` / `ページの半分` / `一覧ごと大きく囲んで` / `升目状に並んで` /
   *   `囲むのは、その升目 1 つです` / `隣り合った升目をまとめて囲んで` /
   *   `おおむね 1 %、多くても 2 %` / `0.02 を超えたら` / `ラベルでは選びません` /
   *   `枠線も手がかりにしないでください` / `下に続く別の図まで伸ばさないで` /
   *   `隣の写真が少しでも入っていたら`。
   *
   * ⚠⚠ **外した文が止めていた実測は、値ごとここに残す**（戻す判断の材料）:
   *   - 1 回目: 図の一覧を**まとめて**囲んだ枠が 3 つとも返り、面積 9〜13 % で
   *     `usableBox()` の `MAX_AREA_RATIO`(0.08) を超えて**全部捨てられた**。
   *   - 2 回目: **写真 4 枚ぶん**をまとめて囲んだ（面積 0.029）。
   *   - 3 回目: 依頼書1 = **0.0048**、依頼書2 = **0.0080**。大きさは合った。
   *   - 4 回目: 位置で選ばせた版は **0.0132〜0.0156**。
   *     ⚠⚠ **場所の文と大きさの文をまとめて捨てた版は 0.0990** で `MAX_AREA_RATIO` に
   *     弾かれ、**1 枚も切り出せなかった**。⚠ **場所の文のほうは今回も残してある。**
   *   文面そのものは git の履歴 (`prompts/picture-location.ts`) から拾える。
   *   ⚠ **戻すなら、まず実測を取り直すこと**（`lib/picture-box.ts` の閾値は触らない）。
   *
   * ⚠ **「サイズの語が戻っていないこと」の否定テストは足さない。** 実測しだいで
   *   戻す手札を残しておくため（禁止にするのは `格子状` の 1 語だけ）。
   */
  it("⚠⚠ 代表の図はいちばん左上の 1 つを、絵の部分だけ囲ませる", () => {
    // ① 場所の軸 — **位置だけ**で選ぶ。
    expect(ALL.picture_location).toMatch(/いちばん左上/);
    expect(ALL.picture_location).toContain("選ぶのは 1 つだけです");
    // ② 何を囲むか — ⚠⚠ 「画像部分だけ・イラスト部分だけ」がこの 1 行に乗っている。
    expect(ALL.picture_location).toContain("絵の部分だけ");
    expect(ALL.picture_location).toMatch(/隣の図は入れません/);
    /*
     * ③ ⚠⚠ **割合の基準**。帯 (`PICTURE_ZOOM_BANDS = 6`) を一緒に渡しているので、
     *   これが消えると**帯を 1 とした座標**が返りうる (`steps/locate-pictures.ts` の注記)。
     */
    expect(ALL.picture_location).toMatch(/ページ全体の画像/);
  });

  /**
   * ⚠⚠ **落とした語が戻ってこないことを固定する。**
   *   「格子状」は実測で**枠のある図（＝形状参考）へ誘導していた**。
   *   ⚠ 戻すなら、まず実測をやり直すこと。
   *   ⚠ **「左上」の禁止は外した**（いまは逆に必須。上の固定を見ること）。
   *   ⚠ 大きさを締めていた「升目」も落としたが、**そちらは禁止にしない**
   *     （戻す手札を残すため。上の固定のコメントを見ること）。
   */
  it("⚠⚠ 格子状で図を選ばせない", () => {
    expect(ALL.picture_location).not.toMatch(/格子状/);
  });

  /**
   * ⚠⚠ **Remark について言うのは 2 点だけ**:「見出しが無い」「オーダーNo の値の真下に、
   *   大きめの文字で印字されている」。
   *
   * ⚠⚠ **外したもの**と、それが止めていた実測 (戻す判断の材料):
   *   - 「手書きの書き込みがこの欄に重なって。印字だけを読み、読めなければ null」
   *     … 「**null にせず低い confidence で返す**」と書いたら、2 明細とも
   *     紙に無い値 (confidence 60 / 50) が返った。この欄に重なる手書きを読んでいた。
   *     ⚠ 手書きを読まない規則は `common.ts` の共通の 6 条に残っている (上の固定)。
   *     ⚠ 「null にせず」は**戻さない** (下で禁止したまま)。
   *   - 「オーダーNo の列に値が縦に 2 つ並ぶ (上 = 長い数字 / 下 = remarkText)。
   *     下の値は行ごと見出しに見える」 … 実測で 1/4 → 3/5 に上がった。
   *   - 「アルファベット 2 文字 + 数字の短い符号」「品位名ではない」「拡大画像で確かめる」
   *     「他の明細に写さない」。
   *   外した理由: 条件を重ねた版で 2 明細とも null (confidence 0) に戻った。
   *   **条件を重ねるほど「当てはまらないから null」と判断しやすくなる**、という見立て。
   *   形の決めつけ (アルファベット 2 文字) は**実際には無い決まり**だった。
   *   文面そのものは git の履歴 (`prompts/forms/form1.ts`) から拾える。
   */
  it("⚠⚠ remarkText は見出しが無く、オーダーNo の値の真下にあると言う", () => {
    for (const prompt of [ALL.purchase_order, promptFor("purchase_order", "FORM1")]) {
      expect(prompt).toContain("remarkText");
      expect(prompt).toMatch(/見出しがありません/);
      expect(prompt).toMatch(/オーダーNo[^。|]*真下/);
    }
    // ⚠⚠ でっち上げを招いた言い方が戻っていないこと。
    expect(ALL.purchase_order).not.toContain("null にせず");
  });

  /**
   * ⚠⚠ 実測: 6 行の表の説明で 3 行目を「見出しの行」と**だけ**言い、
   *   タイトルの値の行を「資材名ではない」と**だけ**言っていたら、2 明細とも
   *   **タイトルの値を remarkText として** confidence 90 で返した。
   *   「オーダーNo の真下 (= 3 行目)」と「3 行目は見出しの行」が矛盾し、行き先の無い
   *   タイトルの値が「見出しの無い欄」に収まった。**2 つは対で残す。**
   */
  it("⚠⚠ 様式① は 3 行目のいちばん左が値で、タイトルの値は remarkText ではないと言う", () => {
    const prompt = promptFor("purchase_order", "FORM1");
    expect(prompt).toMatch(/オーダーNo」?の列の欄だけは見出しではなく値[^。]*remarkText/);
    // ⚠⚠ 「いちばん左の欄」と言わない。紙のいちばん左は細い「行」の列で、そこに掛かる
    //   手書きの丸を 5 回中 4 回読んだ (`ZQA` / `ZQB` / `ZQC` / `ZRA`)。
    expect(prompt).not.toMatch(/いちばん左の欄[^。]*remarkText/);
    expect(prompt).toMatch(/remarkText でもありません/);
  });

  /**
   * ⚠⚠ 実測: 「見出しが無い・オーダーNo の下・大きめの文字」は
   *   表の左端の**丸いハンコ**にも当てはまる (見出しが無く、オーダーNo の左下にあり、字が大きい)。
   *   外れた回はどれも**ハンコを読んだ紙に無い値**で、**2 明細とも同じ値**だった
   *   (`ZRB` / `ZQC` / `ZQA` / `ZRA` / `ZQB`)。
   *   ⚠ 読む場所を**セル 1 つ**に絞り、ハンコを名指しで外す。**2 つは対で残す。**
   */
  it("⚠⚠ 様式① は remarkText をオーダーNo のすぐ下のセルに絞り、ハンコを外す", () => {
    const prompt = promptFor("purchase_order", "FORM1");
    expect(prompt).toMatch(/オーダーNo[^。|]*すぐ下のセル/);
    expect(prompt).toMatch(/ハンコ[^。]*。\**remarkText ではありません/);
  });

  /**
   * ⚠⚠ 実測 (`openai/gpt-5` で 3 回): 行頭がタイ文字の行が 3 回とも外れた
   *   (半角カナに化ける / 記号に化ける / 行ごと null)。後ろの英数字は取れていた。
   *   **特定の欄ではなく帳票全体の前提**なので、様式の差分ではなく共通の規則で全役割に言う。
   */
  it.each(ROLES)("⚠⚠ %s は日本語・タイ語・英数字が 1 つの語の中で混ざると言う", (role) => {
    expect(ALL[role]).toMatch(/日本語・タイ語・英数字が混ざります/);
    expect(ALL[role]).toMatch(/1 つの語の中で混ざる/);
    expect(ALL[role]).toContain("タイ文字はタイ文字のまま");
    // 化け方の実測 (カナ・記号) と、翻訳・ローマ字への置き換えを名指しで止める。
    expect(ALL[role]).toMatch(/翻訳/);
    expect(ALL[role]).toMatch(/ローマ字/);
    expect(ALL[role]).toMatch(/カナ・記号/);
    expect(ALL[role]).toMatch(/読めた部分まで捨てない/);
  });

  /** ⚠ 発注No と明細のオーダーNo の取り違えは実測で起きた。 */
  it("⚠ 発注No は右上にあり、オーダーNo とは別だと言う", () => {
    expect(ALL.purchase_order).toContain("右上");
    expect(ALL.purchase_order).toContain("オーダーNo");
  });

  /**
   * ⚠⚠ 実測: 文面が**紙のどこを見るかを一切言っていない**ため、モデルが毎回ページ全体を
   *   探していた。紙面の位置は**様式ごと**の話なので `forms/form1.ts` が持つ
   *   (`steps/` と `lib/` は触らない)。**落とさないこと。**
   *
   * ⚠ **見出しは役ごとに違う。** 読み取りの 2 役は紙面の説明なので `# この様式の紙面`、
   *   代表の図は**狙う 1 つがどのあたりに居るか**だけなので `# 担当位置`。
   *   見出しを持つのは `forms/<code>.ts` の文字列**だけ**で、
   *   `layout.ts` は受け取ったものを末尾に足すだけ。
   */
  it("⚠⚠ 様式① は紙のどこを見るかを言う", () => {
    // ⚠ 様式の差分が効くのは 3 役だけ (classify と link は受け取らない)。
    const headings = {
      purchase_order: "この様式の紙面",
      spec_sheet: "この様式の紙面",
      picture_location: "担当位置",
    } as const;
    for (const [role, heading] of Object.entries(headings) as [
      keyof typeof headings,
      string,
    ][]) {
      expect(promptFor(role, "FORM1")).toContain(heading);
      // 様式が分からないときは足さない (本文だけ)。
      expect(promptFor(role, null)).not.toContain(heading);
    }
  });
});

// ── (c) 禁止 ────────────────────────────────────────────────────────────────

describe("⚠ 戻ってはいけないもの", () => {
  /**
   * ⚠⚠ **実際の値が指示文に無いこと**。下部のメモの読み取りは
   *   「AI が紙から本当に値を読めている」ことの証明なので、値を指示文に書いた瞬間に
   *   **読めたのか写したのかが区別できなくなる**。
   * ⚠ 下の断片は実物のサンプル (非公開) のメモの値のうち、
   *   **取引先を名指ししない一般の語**。様式の差分 (`FORM1`) も含めて全役割を見る。
   * ⚠⚠ **取引先の名前・略号・ロゴ・実在の番号はここに書かない**。一覧そのものが
   *   取引先を名指しするので、手元に置いた `assets/banned-terms.txt` (1 行 1 語) から読む
   *   (下の「禁止語」。リポジトリには含まない。無ければそのテストは飛ばす)。
   */
  it.each(ROLES)("⚠⚠ %s にサンプルのメモの値が書かれていない", (role) => {
    // ⚠ `ชุบ` は Description#3 の行頭のタイ語。タイ文字全体も下で範囲ごと禁止している。
    // ⚠ `°C` / `℃` は記号の一部 (どちらの字形でも書かない)。
    const fragments = ["POLISH", "K18", "°C", "℃", "SILVER", "#10", "ダイヤモンド", "ชุบ"];
    for (const prompt of [promptFor(role, null), promptFor(role, "FORM1")]) {
      for (const fragment of fragments) {
        expect(prompt).not.toContain(fragment);
      }
    }
  });

  it.skipIf(BANNED_TERMS.length === 0).each(ROLES)(
    `⚠⚠ %s に禁止語が書かれていない${BANNED_TERMS.length === 0 ? ` (${BANNED_TERMS_PATH} が無いので飛ばす)` : ""}`,
    (role) => {
      for (const prompt of [promptFor(role, null), promptFor(role, "FORM1")]) {
        for (const term of BANNED_TERMS) {
          expect(prompt.includes(term), term).toBe(false);
        }
      }
    },
  );

  /**
   * ⚠⚠ **Remark の形を決めつけない**。「アルファベット 2 文字 + 数字」という決まりは
   *   **実際には無い**。決めつけると、当てはまらない符号を null にする。
   */
  it.each(ROLES)("⚠⚠ %s に「アルファベット 2 文字」が書かれていない", (role) => {
    for (const prompt of [promptFor(role, null), promptFor(role, "FORM1")]) {
      expect(prompt).not.toMatch(/アルファベット\s*2\s*文字/);
    }
  });

  /**
   * ⚠⚠ **指示文にタイ文字を 1 文字も書かない**。書くのは「タイ語が混ざる」という
   *   文字の種類の説明までで、**サンプルのタイ語の語そのもの**を書くと、読めたのか写したのかが
   *   区別できなくなる (サンプルの値を書かないのと同じ理由)。語を 1 つずつ禁止するより強いので、範囲で見る。
   */
  it.each(ROLES)("⚠⚠ %s にタイ文字が書かれていない", (role) => {
    for (const prompt of [promptFor(role, null), promptFor(role, "FORM1")]) {
      expect(prompt).not.toMatch(/[\u0E00-\u0E7F]/u);
    }
  });

  /**
   * ⚠⚠ 出荷日は**出どころが確定できないので読むのをやめた** (人が埋める欄)。
   *   実物には「印字された納期」「手書きの出荷日」「手書きの渡し日」があり、
   *   実物の ORDER SHEET の値は**そのどれとも一致しない**。
   */
  it.each(ROLES)("%s に出荷日を読ませる言葉が無い", (role) => {
    expect(ALL[role]).not.toContain("shipDate");
    expect(ALL[role]).not.toContain("出荷予定日");
  });

  /**
   * ⚠⚠ **様式の知識は `forms/` と `index.ts` の表だけが持つ。**
   *   ここが落ちたら「表に足したか」を先に確かめること
   *   (2 件目の様式を足したときは、この期待値を更新するのが正しい)。
   */
  it("⚠ 共通の本文に 2 件目以降の様式の名前が出てこない", () => {
    for (const role of ["purchase_order", "spec_sheet", "picture_location", "link"] as const) {
      expect(ALL[role]).not.toMatch(/様式パターン[②③④⑤]/);
    }
  });

  /** ⚠ `structuredOutput` が構造を保証するので、形の説明で文字数を使わない。 */
  it("⚠ 「決められた形以外を返さない」のような冗長な指示を持たない", () => {
    for (const role of ROLES) {
      expect(ALL[role]).not.toContain("決められた形以外のものを返してはいけません");
    }
  });
});
