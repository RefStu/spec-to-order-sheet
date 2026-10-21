/**
 * 製造番号で発注書と依頼書を突き合わせる。
 *
 * ⚠ **3 帳票すべてに同じ番号が印字されている**ので、これが繋ぐ鍵になる:
 *   発注書の「製造番号」= 依頼書の「仕様書No」= ORDER SHEET の Code master 1 段目。
 * ⚠ **結びつかなかった明細も行は作る。** 空のまま先へ進める。
 */

/**
 * 突き合わせのために番号を寄せる。
 *
 * 帳票ごとに書き方が揺れる (全角、空白、ハイフンの有無、大小文字) ので、
 * **比べるときだけ**この形にする。DB には印字そのままを入れる。
 */
export function normalizeSpecNo(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const normalized = value
    // 全角の英数字と記号を半角に寄せる。
    .replace(/[Ａ-Ｚａ-ｚ０-９－―‐]/g, (ch) => {
      if (ch === "－" || ch === "―" || ch === "‐") return "-";
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    })
    .toUpperCase()
    // 区切りは意味を持たない (MFG-000123 と MFG 000123 は同じ番号)。
    .replace(/[\s\-_.]/g, "");

  return normalized.length > 0 ? normalized : null;
}

/**
 * 比べるための鍵。**1 つの番号から複数の鍵が出る。**
 *
 * ⚠⚠ **帳票によって年の桁が違う。** 実物では発注書が 2 桁年 (`YY-MM-Sxxx`)、
 *   依頼書が 4 桁年 (`YYYY - MM - Sxxx`) で印字されていて、
 *   正規化しただけでは **`YYMMSxxx` と `YYYYMMSxxx` になって一致しない**。
 * ⚠ **縮める向きだけ**を足す。2 桁を 4 桁に伸ばすと**世紀を当てずっぽうで決める**ことになる。
 * ⚠ これは**年の桁数の正規化**であって、様式の判定ではない。
 *   取引先ごとの分岐をここに書かないこと (様式の判定は別の処理)。
 */
export function specNoKeys(value: string | null | undefined): string[] {
  const base = normalizeSpecNo(value);
  if (base === null) return [];
  const keys = [base];
  // 先頭が 19xx / 20xx のときだけ、2 桁年に縮めた鍵も候補にする。
  if (base.length > 4 && /^(19|20)\d{2}/.test(base)) keys.push(base.slice(2));
  return keys;
}

/**
 * 予備の鍵に使える最短の長さ。
 * ⚠ 短すぎる鍵で結ぶと**関係のない明細と依頼書がくっつく**。
 */
const MIN_FALLBACK_KEY_LENGTH = 3;

export interface SpecMatchInput {
  /** 発注書の明細。`purchase_order_lines` の印字そのまま。 */
  lines: { lineId: string; rawModelNo: string | null; rawProductName?: string | null }[];
  /** 依頼書。`revision_requests` の印字そのまま。 */
  revisions: {
    revisionRequestId: string;
    specNo: string | null;
    productName?: string | null;
  }[];
}

/**
 * 何で結んだか。**混ぜない** (どれで結んだかで確からしさが違う)。
 * ⚠ `model` = 規則では結べず、ai の対応づけ (`links`) で結んだもの。
 */
export type MatchedBy = "spec_no" | "product_name" | "model";

export interface SpecMatchResult {
  /** 明細 1 行につき 1 つ。結びつかなくても**必ず入る**。 */
  matches: { lineId: string; revisionRequestId: string | null; matchedBy: MatchedBy | null }[];
  /** どの明細にも結びつかなかった依頼書 (人が見る材料)。 */
  unmatchedRevisionIds: string[];
}

/** 鍵 → 依頼書。**同じ鍵に 2 件以上ぶら下がったら使わない** (でっち上げ防止)。 */
function indexBy(
  revisions: SpecMatchInput["revisions"],
  keysOf: (r: SpecMatchInput["revisions"][number]) => string[],
  minLength: number,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const revision of revisions) {
    for (const key of keysOf(revision)) {
      if (key.length < minLength) continue;
      // ⚠ 既にある鍵は **null にして無効化**する (あいまいなものは結ばない)。
      index.set(key, index.has(key) ? null : revision.revisionRequestId);
    }
  }
  return index;
}

/**
 * 発注書の明細と依頼書を結ぶ。
 *
 * 1 巡目 … **仕様書No どうし**。完全一致を、年を縮めた鍵より先に当てる。
 * 2 巡目 … 残った明細だけ、**品名**も鍵に加えて結ぶ
 *          (実物には製造番号が印字されていない明細がある)。
 *
 * ⚠ **製造番号で結ぶときは 1 対多を許す。** 同じ品物を複数の明細で頼むことがあり、
 *   そのときはどの明細も同じ依頼書を指すのが正しい。
 * ⚠⚠ **品名で結ぶときだけは 1 対 1 に縛る。** 鍵が弱いので、取り違えると
 *   **関係の無い依頼書が複数の明細に広がる**。
 */
export function matchBySpecNo(input: SpecMatchInput): SpecMatchResult {
  const bySpecNo = indexBy(input.revisions, (r) => specNoKeys(r.specNo), 1);
  const byProductName = indexBy(
    input.revisions,
    (r) => [...specNoKeys(r.specNo), ...specNoKeys(r.productName)],
    MIN_FALLBACK_KEY_LENGTH,
  );

  const used = new Set<string>();
  const matches: SpecMatchResult["matches"] = input.lines.map((line) => ({
    lineId: line.lineId,
    revisionRequestId: null,
    matchedBy: null,
  }));

  /**
   * 鍵の一覧を順に当てる。**先に来た鍵ほど強い**(完全一致 → 年を縮めた鍵 → 品名)。
   * `once` が真のときは、既に使われた依頼書には付けない。
   */
  function tryMatch(
    index: Map<string, string | null>,
    keys: string[],
    matchedBy: MatchedBy,
    slot: SpecMatchResult["matches"][number],
    once: boolean,
  ): boolean {
    for (const key of keys) {
      const revisionRequestId = index.get(key);
      if (!revisionRequestId) continue;
      if (once && used.has(revisionRequestId)) continue;
      used.add(revisionRequestId);
      slot.revisionRequestId = revisionRequestId;
      slot.matchedBy = matchedBy;
      return true;
    }
    return false;
  }

  // 1 巡目: 製造番号。
  input.lines.forEach((line, i) => {
    const slot = matches[i];
    if (!slot) return;
    tryMatch(bySpecNo, specNoKeys(line.rawModelNo), "spec_no", slot, false);
  });

  // 2 巡目: 残った明細だけ品名で。
  input.lines.forEach((line, i) => {
    const slot = matches[i];
    if (!slot || slot.revisionRequestId) return;
    const keys = [...specNoKeys(line.rawModelNo), ...specNoKeys(line.rawProductName)].filter(
      (key) => key.length >= MIN_FALLBACK_KEY_LENGTH,
    );
    tryMatch(byProductName, keys, "product_name", slot, true);
  });

  return {
    matches,
    unmatchedRevisionIds: input.revisions
      .map((r) => r.revisionRequestId)
      .filter((id) => !used.has(id)),
  };
}

/**
 * ★ ai が返した対応づけ 1 件 (`extraction.links`)。
 * ⚠ 添字は**その PDF の中**でしか意味を持たない (発注書の明細の順・依頼書の順)。
 */
export interface AiLink {
  lineNo: number;
  specSheetIndex: number | null;
  confidence: number;
}

/**
 * ★★ **規則で結べなかった明細にだけ** ai の対応づけを当てる。
 *
 * ⚠⚠ **正は `matchBySpecNo()` のまま。** 結果は `order_sheet_lines.revision_request_id` に
 *   書き込まれるので、**実行ごとに揺れるもの (モデルの答え) を正にすると、同じ帳票から
 *   違う ORDER SHEET が出る** (STONE で実際に起きた壊れ方)。だからここは**埋め草**に徹する:
 *   - 既に結ばれた明細は**絶対に上書きしない**
 *   - ai が指した依頼書が**既に使われていたら当てない** (1 対 1 の縛りは web が持つ)
 *   - `specSheetIndex` が null の答えは**何もしない** (「結べなかった」は規則と同じ結論)
 * ⚠ 当てたものは `matchedBy: "model"` で残す。**効いているかを後から数えられるようにする。**
 *
 * @param lineIdOf     発注書の明細番号 → `matches` の `lineId`。無ければ null。
 * @param revisionIdOf 依頼書の添字 → `revisionRequestId`。無ければ null。
 */
export function applyAiLinks(
  result: SpecMatchResult,
  links: readonly AiLink[],
  lineIdOf: (lineNo: number) => string | null,
  revisionIdOf: (specSheetIndex: number) => string | null,
): SpecMatchResult {
  const matches = result.matches.map((match) => ({ ...match }));
  const used = new Set(
    matches.map((match) => match.revisionRequestId).filter((id): id is string => id !== null),
  );

  for (const link of links) {
    if (link.specSheetIndex === null) continue;
    const lineId = lineIdOf(link.lineNo);
    const revisionRequestId = revisionIdOf(link.specSheetIndex);
    if (lineId === null || revisionRequestId === null) continue;
    // ⚠ 既に使われている依頼書には当てない (弱い鍵で広げない)。
    if (used.has(revisionRequestId)) continue;

    const slot = matches.find((match) => match.lineId === lineId);
    // ⚠⚠ 既に結ばれた明細は上書きしない (規則のほうが勝つ)。
    if (!slot || slot.revisionRequestId !== null) continue;

    slot.revisionRequestId = revisionRequestId;
    slot.matchedBy = "model";
    used.add(revisionRequestId);
  }

  return {
    matches,
    unmatchedRevisionIds: result.unmatchedRevisionIds.filter((id) => !used.has(id)),
  };
}
