/**
 * **ORDER SHEET の欄を誰が埋めるかの定義。ここだけが正。**
 *
 * ⚠⚠ 実物の ORDER SHEET の欄がそのまま入っている。**増やさない・減らさない。**
 *   これを見るのは 4 か所 — ORDER SHEET の書き込み / GET の応答 / 承認判定 / 正答率。
 *   定義が散らばると 8 欄 / 6 欄がずれていく (区別そのものは固定なので DB に持たず、
 *   ここ 1 か所で持つ)。
 *
 * ⚠ **Remark と Picture は AI の欄**
 *   (Remark は発注書のオーダーNo の下から、Picture は依頼書の代表の図から取る)。
 * ⚠ **工程表 (PRODUCTION PLAN) はここに居ない。** 欄の定義には入れず、
 *   人が自由な文字を打つヘッダのセル (`C4:E10`) として
 *   `order-sheet-layout.ts` の `PLAN_CELLS` が持つ。
 * ⚠ **Unit はここに居ない。** 読み取りではなく固定値 (`PCS`) なので、
 *   AI の欄でも人の欄でもない。
 * ⚠ `shipDate`(明細の Ship date) と `ship`(ヘッダの SHIP) は **別物**。どちらも人の欄で、
 *   ヘッダの SHIP は営業がお客様と相談して決める。**AI の作業はヘッダの SHIP を待たない。**
 */
import { isHeaderCellRef, lineCellRef, parseLineCellRef } from "./order-sheet-layout";

export interface OrderSheetFieldDef {
  /** `ai_extraction_fields.target_table`。 */
  table: string;
  /**
   * 欄の**住所**。
   *
   * ⚠⚠ **明細の欄はここが「列の記号」だけ**（`"D"` など）。番地は行番号を含むので、
   *   12 件ぶんを 1 つの文字列で表せない。**意味は「その明細の値の行の、その列」**で、
   *   実際の番地は `targetColumnOf()` / `aiLineCellRefs()` が明細ごとに解決する。
   * ⚠ **ヘッダの欄はセルの番地**（`"J7"` / `"D12"` / `"F12"` / `"J5"`）。1 つしかないので潰れない。
   * ⚠ 取引先 (`partner_id`) と写真 (`photo_file_id`) は**物理の列名のまま**
   *   （どちらもセルではない — 前者はマスタへの外部キー、後者は絵）。
   * ⚠⚠ `ai_extraction_fields.target_column` に入るのは**解決した後の文字列**
   *   （明細なら `"D16"`）。⚠ 引くときは `fieldKeyOfTarget()` を使うこと。
   */
  column: string;
  by: "ai" | "human";
  /** 画面と応答での欄の名前 (order-sheets/schema.ts の形に対応する)。 */
  label: string;
}

export const ORDER_SHEET_FIELDS = {
  // ── AI が埋める 8 欄 ───────────────────────────────────────────────
  /**
   * ⚠ **いまは必ず空になる。** 発注書には差出人・納入場所・受付窓口が別々に印字されて
   *   いて、どれが CUSTOMER なのかが決まっていない。読み取りをやめたので、
   *   人がマスタを整えるまで埋まらない。**別の会社名を入れるよりは空のほうがよい。**
   */
  customer: { table: "order_sheets", column: "partner_id", by: "ai", label: "CUSTOMER" },
  customerPoNo: {
    table: "order_sheets",
    column: "J7",
    by: "ai",
    label: "CUSTOMER PO / NO",
  },
  codeMaster: { table: "order_sheet_lines", column: "D", by: "ai", label: "Code master" },
  description: { table: "order_sheet_lines", column: "F", by: "ai", label: "Description" },
  size: { table: "order_sheet_lines", column: "H", by: "ai", label: "Size" },
  qty: { table: "order_sheet_lines", column: "I", by: "ai", label: "QTY" },
  remark: { table: "order_sheet_lines", column: "L", by: "ai", label: "REMARK" },
  picture: { table: "order_sheet_lines", column: "photo_file_id", by: "ai", label: "Picture" },

  // ── 人と社内システムが埋める 6 欄 ─────────────────────────────────
  code: { table: "order_sheet_lines", column: "B", by: "human", label: "Code" },
  /**
   * ⚠⚠ ** AI の欄から人の欄へ移した。** 石の読み取りをやめたため
   *   (`prompts/spec-sheet.ts` から「本社石手配」の節を落とした)。
   *   **紙の G 列も画面のセルも残っている** — 人が打ち込む。
   * ⚠⚠ **`order_sheet_line_stones` にはもう書かない**（同じ日にセルへ移した）。
   *   1:N の器が要るのは石の内訳を持つときだけで、いまは紙の 1 セルぶんの文字しか要らない。
   *   `purchase_order_line_stones` / `revision_request_stones` と同じく、
   *   **表は残すが書き手は居ない**（戻すときに困らないように）。
   */
  stone: { table: "order_sheet_lines", column: "G", by: "human", label: "Stone" },
  /**
   * ⚠⚠ **明細の Ship date は人が埋める。** 実物には「印字された納期」「手書きの出荷日」
   *   「手書きの渡し日」が別々にあり、実物の ORDER SHEET の値は**そのどれとも一致しない**
   *   (工程表の最終日と同じだった)。出どころを確定できないので AI には埋めさせない。
   * ⚠ ヘッダの `ship` (`order_sheets.ship_date`) とは**別の列**。混ぜないこと。
   */
  shipDate: { table: "order_sheet_lines", column: "K", by: "human", label: "Ship date" },
  /**
   * ⚠ **`order_sheet_line_ids` にはもう書かない**（セルへ移した）。
   *   表は残してある（`stone` と同じ扱い）。
   */
  internalId: { table: "order_sheet_lines", column: "C", by: "human", label: "ID" },
  poNo: { table: "order_sheets", column: "D12", by: "human", label: "PO" },
  soNo: { table: "order_sheets", column: "F12", by: "human", label: "SO" },
  ship: { table: "order_sheets", column: "J5", by: "human", label: "SHIP" },
} as const satisfies Record<string, OrderSheetFieldDef>;

export type OrderSheetFieldKey = keyof typeof ORDER_SHEET_FIELDS;

/** AI が埋めてよい欄か。**ここが偽の欄に書いてはいけない。** */
export function isAiField(key: OrderSheetFieldKey): boolean {
  return ORDER_SHEET_FIELDS[key].by === "ai";
}

/** 明細の欄か（`column` が**列の記号 1 文字**のもの）。 */
function isLineCellField(key: OrderSheetFieldKey): boolean {
  const def = ORDER_SHEET_FIELDS[key];
  return def.table === "order_sheet_lines" && /^[A-L]$/u.test(def.column);
}

/**
 * ★★ 欄の住所を**その明細で解決した文字列**にする。
 * これが `ai_extraction_fields.target_column` / `ai_field_corrections.target_column` に入る。
 *
 * @param lineIndex 明細の番号（**0 始まり**）。明細の欄なら必須。
 * ⚠ 明細の欄なのに渡さなかったら例外（黙って列の記号のまま保存させない）。
 */
export function targetColumnOf(key: OrderSheetFieldKey, lineIndex?: number): string {
  const def = ORDER_SHEET_FIELDS[key];
  if (!isLineCellField(key)) return def.column;
  if (lineIndex === undefined) throw new Error(`明細の欄には lineIndex が要ります: ${key}`);
  return lineCellRef(def.column, lineIndex, 0);
}

/**
 * **AI が埋める明細のセル**の番地だけを並べる。
 *
 * ⚠ 値が空でも応答に載せるのはこの番地だけ。画面は `by`(本来どちらの欄か) と
 *   `filledBy`(実際に誰が埋めたか) の組で「AI がまだ埋めていないセル」を見分ける
 *   (`cases/lib/field-style.ts` の `fieldTone`)。人のセルは空なら載せなくてよい。
 */
export function aiLineCellRefs(lineIndex: number): string[] {
  return (Object.keys(ORDER_SHEET_FIELDS) as OrderSheetFieldKey[])
    .filter((key) => isAiField(key) && isLineCellField(key))
    .map((key) => targetColumnOf(key, lineIndex));
}

/** AI の欄の表と鍵（正答率の分母を数えるときに使う）。 */
export function aiFieldTargets(): { table: string; key: OrderSheetFieldKey }[] {
  return (Object.keys(ORDER_SHEET_FIELDS) as OrderSheetFieldKey[])
    .filter(isAiField)
    .map((key) => ({ table: ORDER_SHEET_FIELDS[key].table, key }));
}

/**
 * ★★ `(表, 来歴の列)` から欄の鍵を引く。**正答率の照合はこれ 1 本。**
 *
 * ⚠⚠ **昔の書き方も読めるようにしてある。** 来歴の行は**書き換えない**運用なので、
 *   `ai_extraction_fields` には世代の違う文字列が混ざっている（実データで確認済み）:
 *   - いま … `"D16"`（絶対番地）
 *   - その前 … `"D:0"`（相対の鍵）
 *   - それ以前 … `"customer_item_code_text"` のような**物理の列名**
 *   **読めなくすると 正答率の分母がその分だけ減って、率が嘘になる。**
 *   ⚠ 読むだけで、**書くのは常にいまの形**（`targetColumnOf()`）。
 */
export function fieldKeyOfTarget(table: string, column: string): OrderSheetFieldKey | undefined {
  const keys = (Object.keys(ORDER_SHEET_FIELDS) as OrderSheetFieldKey[]).filter(
    (key) => ORDER_SHEET_FIELDS[key].table === table,
  );

  // ① いまの形と、セルではない欄（partner_id / photo_file_id / ヘッダの番地）。
  const exact = keys.find((key) => ORDER_SHEET_FIELDS[key].column === column);
  if (exact) return exact;

  if (table !== "order_sheet_lines") return LEGACY_LINE_COLUMNS[column];

  // ② 絶対番地（`"D16"`）。⚠ 値の行だけが欄（継ぎ行は欄ではない）。
  const parsed = parseLineCellRef(column);
  if (parsed && parsed.rowOffset === 0) {
    const byColumn = keys.find((key) => ORDER_SHEET_FIELDS[key].column === parsed.column);
    if (byColumn) return byColumn;
  }

  // ③ 昔の相対の鍵（`"D:0"`）。
  const relative = /^([A-L]):0$/u.exec(column);
  if (relative) {
    const byColumn = keys.find((key) => ORDER_SHEET_FIELDS[key].column === relative[1]);
    if (byColumn) return byColumn;
  }

  // ④ もっと昔の物理の列名。
  return LEGACY_LINE_COLUMNS[column];
}

/**
 * ⚠ **相対の鍵より前に書かれた来歴の列名**。読むためだけにある（書かない）。
 * 実データに残っているものだけを並べてある。
 */
const LEGACY_LINE_COLUMNS: Record<string, OrderSheetFieldKey | undefined> = {
  customer_item_code_text: "codeMaster",
  description_text: "description",
  size_text: "size",
  quantity: "qty",
  remark: "remark",
  customer_po_no: "customerPoNo",
  po_no: "poNo",
  so_no: "soNo",
  ship_date: "ship",
};

/**
 * 画面と応答で使う欄の名前（**= 住所**）。
 *
 * ⚠⚠ **明細は番地そのもの**（`"D16"`）。相対の鍵から変えた。
 *   ヘッダも番地（`"J7"` など）なので、**画面から見える鍵は全部 xlsx の番地に揃っている**。
 * ⚠ 写真 (`picture`) はセルではない（E 列は文字ではなく絵）。`PICTURE` のまま。
 */
export const PICTURE_WIRE_KEY = "PICTURE";

export function wireKeyOf(key: OrderSheetFieldKey, lineIndex?: number): string {
  if (key === "picture") return PICTURE_WIRE_KEY;
  return targetColumnOf(key, lineIndex);
}

/**
 * 画面の欄の名前（= 番地）から**欄の定義**を引く。
 *
 * ⚠ 一覧に無いものは `undefined`。**正答率に数えない欄**（継ぎ行や人だけのセル）なので、
 *   呼び手は黙って飛ばしてよい。
 * ⚠ ヘッダの番地（行 5 / 7 / 12）と明細の番地（行 15〜86）は**重ならない**ので、
 *   表を渡さなくても一意に決まる。
 */
export function fieldDefOf(wireKey: string): OrderSheetFieldDef | undefined {
  const key = fieldKeyOfWireKey(wireKey);
  return key === undefined ? undefined : ORDER_SHEET_FIELDS[key];
}

/** 画面の欄の名前 → 欄の鍵。 */
export function fieldKeyOfWireKey(wireKey: string): OrderSheetFieldKey | undefined {
  if (wireKey === PICTURE_WIRE_KEY) return "picture";
  if (isHeaderCellRef(wireKey) || HEADER_DERIVED_REFS.includes(wireKey)) {
    return fieldKeyOfTarget("order_sheets", wireKey);
  }
  return fieldKeyOfTarget("order_sheet_lines", wireKey);
}

/** ⚠ 読み取り専用の派生セル（人は打てないが、欄としては引ける）。 */
const HEADER_DERIVED_REFS: readonly string[] = ["A12", "J12", "F5"];

/**
 * その欄は**誰が埋める欄か**。
 *
 * ⚠ 一覧に無い欄 (Unit や継ぎ行など) は**人の欄**として返す。AI が埋めないため。
 * ⚠ `filledBy` (実際に誰が埋めたか) とは別物。`by` は「本来どちらの欄か」。
 *   画面はこの 2 つで「まだ AI が埋めていない欄」を見分ける (取り込み中のスピナー)。
 */
export function fieldOwner(wireKey: string): "ai" | "human" {
  const key = fieldKeyOfWireKey(wireKey);
  return key === undefined ? "human" : ORDER_SHEET_FIELDS[key].by;
}
