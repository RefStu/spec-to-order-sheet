import type { CELL_COLUMNS } from "./order-sheet-form";
import {
  HEADER_FIELD_LABELS,
  type Field,
  type OrderSheet,
  type OrderSheetLinePhoto,
} from "./order-sheet-contract";
import {
  BLANK_CELL,
  BLOCK_COUNT,
  BLOCK_ROWS,
  cellRefOf,
  DERIVED_HEADER_CELLS,
  FIRST_BLOCK_ROW,
  HEADER_PREFIXES,
  HEADER_VALUE_CELLS,
  isLineCellRef,
  PLAN_CELLS,
  qtyRefOf,
  SHEET_HEADINGS,
  TOTAL_UNIT_TEXT,
  totalRowOf,
  VALUE_ROW,
} from "./order-sheet-form";

/**
 * ★★ ORDER SHEET の画面を**転記のための GUI** に組み立てる。
 *
 * ⚠⚠ **紙の格子を再現しない。** 帳票は A..L × 1..88 の 1 枚の格子（約 1000 セル）だが、
 *   1000 セルの格子は Web では見にくいので、区画（セクション）と入力欄の形にした。
 *   ⚠ 実物との突き合わせは xlsx を出して行う（画面の仕事ではない）。
 *
 * ⚠⚠ **これは純関数。** このリポジトリに DOM のテストは 1 つも無い
 *   （`apps/web/vitest.config.ts` は `environment: "node"`）。
 *   **形はここで決めてテストし、JSX は「返ってきたものを描くだけ」にする。**
 * ⚠⚠ **セルの鍵は xlsx の絶対番地。** 区画は見せ方だけで、
 *   `cells_json` も API の契約も xlsx も番地で持つ。
 * ⚠ ここに「AI の欄 / 人の欄」を書かない。塗り分けは `field-style.ts` の `fieldTone()` が
 *   API の返す `by` / `filledBy` / `confidence` / `corrected` だけで決める。
 *   区画分けは**紙の場所**による分類であって、「AI の欄 / 人の欄」ではない。
 */

export type SectionId = "productionPlan" | "customer" | "shipCustomerPo" | "orderSheet";

/** 入力欄 1 つ。⚠ `ref` は `cellRefOf()` からの導出で、**番地を直書きしない**。 */
export interface FieldSpec {
  /** 下書きの鍵の右半分。**同時に xlsx の絶対番地**（`"F20"`）。 */
  ref: string;
  /** 下書きの鍵の左半分。`"header"` か `lineId`（空文字 = 保存できない枠）。 */
  scope: string;
  /** 見出し（`"Description #4"`）。⚠ 番地は入れない（読み上げで番地が先に来る）。 */
  label: string;
  /**
   * 記入例。
   *
   * ⚠⚠ **実データを書かない。** 実物の xlsx はリポジトリに含めない（手元に置いたときだけ
   *   使う）が、このファイルはコミットされる。取引先・ロゴ・品番が分かる値は
   *   **形だけ似せた架空の値**に置き換えてある。
   */
  placeholder: string;
  /**
   * ⚠⚠ **API が返した `Field` そのままの参照**（無い鍵は `BLANK_CELL`。これも同一参照）。
   *   毎回組み立て直すと、欄を包む `memo` が素通りして全欄が描き直される。
   */
  field: Field;
  editable: boolean;
  /**
   * ★ 紙の印字の接頭辞（`SHIP : ` など）。**入力欄の前に出す。**
   *
   * ⚠⚠ xlsx は接頭辞と値を 1 つのセルに入れるので、画面にも出さないと
   *   **画面と xlsx で文字が違う**。値には入れない（打つのは値だけ）。
   * ⚠ ヘッダの 6 欄だけ。ほかの欄は `undefined`。
   */
  prefix?: string;
}

/** 明細 1 件のカード。 */
export interface LineCardSpec {
  /** ⚠ 空文字 = 取り込み中の仮の明細。**保存に混ぜない**（writer が捨てる）。 */
  lineId: string;
  /** 1..`BLOCK_COUNT`。 */
  lineNo: number;
  title: string;
  /** 合計を数えるセルの番地。⚠ 欄の `ref` と一致する（ずれたらテストが落ちる）。 */
  qtyRef: string;
  /** Picture — 代表の図（E 列）。⚠ 文字のセルではないので `fields` に入らない。 */
  picture: {
    label: string;
    field: Field;
    photos: OrderSheetLinePhoto[];
    fileId: string | null;
    deletable: boolean;
  };
  /**
   * ★★ 欄を**行ごと**に持つ。1 要素 = 画面の 1 行。
   *
   * ⚠⚠ **並びは転記する紙の読み順に合わせてある:**
   *   `Code / ID` → `Code Master #1 / #2` → `Description #1..#4` → `STONE` →
   *   `Size / QTY / Unit` → `SHIP DATE / REMARK`。
   *   ⚠ **1 行に何欄置くかは、この配列の長さがそのまま決める。**
   *   部品は長さから列数を選ぶだけで、並べ替えの知識を持たない。
   * ⚠ 一覧に無い番地に値が残っていたら、**最後の行**に足す（`buildLineCards()`）。
   */
  rows: FieldSpec[][];
}

/** カードの全欄（行をまたいで 1 本に）。⚠ 合計やテストが使う。 */
export function cardFields(card: LineCardSpec): FieldSpec[] {
  return card.rows.flat();
}

/**
 * 区画。⚠⚠ **4 つとも必ず作る。** `visible: false` でも中身は組み立てる
 *   — 画面に出さないだけで、API からも json からも xlsx からも外していないため。
 */
export interface SectionSpec {
  id: SectionId;
  title: string;
  visible: boolean;
  /** ヘッダ側の欄。明細の区画では空配列。 */
  fields: FieldSpec[];
  /** 明細のカード。ヘッダの区画では空配列。 */
  lines: LineCardSpec[];
}

export interface OrderSheetForm {
  /** 常に 4 つ・紙の順（工程表 → 取引先 → 出荷と発注No → 明細）。 */
  sections: SectionSpec[];
  /**
   * `G7` / `I<合計>`。⚠ 欄ではない（雛形の数式）。
   *
   * ⚠⚠ **合計の行は明細の数で動く**（2 件なら `I28` / `J28`、12 件なら `I88` / `J88`）。
   *   xlsx と同じ番地を `totalRowOf()` の写しから出す。画面は番地を見出しに出さない
   *   （読み上げで番地が先に来る）ので、`cell` は `title` とテストのためにある。
   */
  total: { label: string; unit: string; cell: string; unitCell: string };
}

/**
 * ⚠⚠ **PRODUCTION PLAN と Customer は画面に出さない**（転記の対象にしていないため）。
 *   畳んで開ける形にはしない — 開けたら打ててしまうので、**DOM ごと出さない**。
 *   **出すときは、ここの `false` を `true` にする 1 行だけでよい。**
 * ⚠⚠ **データは 1 つも外していない。** 工程表（`C4:E10`）は `HEADER_VALUE_CELLS` 経由で
 *   `order-sheets/lib/order-sheet-xlsx.ts` の `toXlsxInput()` に流れ続ける。
 *   **ここを「使っていないから」と削ると、保存はされるのに xlsx に出ない状態に戻る。**
 */
const SECTION_VISIBLE: Readonly<Record<SectionId, boolean>> = {
  productionPlan: false,
  customer: false,
  shipCustomerPo: true,
  orderSheet: true,
};

const SECTION_TITLE: Readonly<Record<SectionId, string>> = {
  productionPlan: "PRODUCTION PLAN",
  customer: "Customer",
  shipCustomerPo: "SHIP & Customer PO",
  orderSheet: "ORDER SHEET",
};

/**
 * ★ 「SHIP & Customer PO」に置くヘッダの番地。
 *
 * ⚠ **紙の右上にある 2 つ**（`J5:L6` と `J7:L8`）。ここだけは紙の場所による決めごとなので
 *   一覧で持つ。**残りのヘッダは導出**する（工程表は `PLAN_CELLS`、それ以外は Customer）。
 *   ⚠⚠ **Customer PO(`J7`) を CUSTOMER(`A12`) と並べない。** 紙の反対側にあり、出どころも違う
 *   （前者はお客様の発注書に印字、後者と PO/SO は社内システムの採番）。
 * ⚠ 取りこぼしは `order-sheet-sections.test.ts` が検出する
 *   （ヘッダの番地はどれか 1 つの区画に必ず入る）。
 */
const SHIP_CUSTOMER_PO_REFS: readonly string[] = ["J5", "J7"];

/**
 * ★ ヘッダの記入例。⚠ **形を似せた架空の値**（実データを書かない）。
 *   派生（打てない）欄は、値の出どころを括弧で書く。
 */
const HEADER_PLACEHOLDERS: Readonly<Record<string, string>> = {
  // ⚠ 日付は実物の書き方（`d/m/yy`。例: `1/2/99`、`15/3/99`）。
  J5: "15/3/99",
  J7: "F10009999",
  D12: "9012345",
  F12: "9012346",
  A12: "（取引先マスタから）",
  J12: "（xlsx を出した日）",
  F5: "（取引先マスタから）",
};

/**
 * ★★ 明細 1 件が持つ入力。**画面の 1 行 = この配列の 1 要素**。
 *
 * ⚠⚠ **番地を書かない。** `cellRefOf(column, lineNo, rowOffset)` が作る。
 *   `toXlsxInput()` が番地をべた書きすると、
 *   **保存もリロードも通るのに xlsx にだけ出ない**という壊れ方になる（例外も警告も出ない）。
 *   **同じ形を作らないこと。**
 * ⚠ `rowOffset` は**値の行からの差**（0 = 枠の 2 行目 = 行 16）。
 * ⚠ 見出しは `SHEET_HEADINGS` の 14 行目から引く（**対応表を 2 か所に持たない**）。
 *
 * ⚠⚠ **どの列を何行ぶん出すかは、実物を実測して決めた**（実物の
 *   明細 2 件とも同じ形だった）。Code Master は 2 行、Description は 4 行、ほかは 1 行。
 *   ⚠⚠ **Description の `rowOffset: 3`（`F19`）は実物が空なので欄にしない。**
 *   だから `Description #4` は `F20`（`#n` は**並び順**であって `rowOffset + 1` ではない）。
 *   ⚠ 戻すときは、Description の行に 1 つ足すだけでよい。
 *
 * ⚠⚠ **行の切り方は転記の読み順。**
 *   **勝手に詰めたり流したりしないこと**（`sm:grid-cols-2` に流すと Description が折り返す）。
 */
interface LineSlot {
  column: (typeof CELL_COLUMNS)[number];
  rowOffset: number;
  placeholder: string;
}

const LINE_ROWS: readonly (readonly LineSlot[])[] = [
  [
    { column: "B", rowOffset: 0, placeholder: "9ZZZ209905S000ABC" }, // Code
    { column: "C", rowOffset: 0, placeholder: "900301" }, // ID
  ],
  [
    { column: "D", rowOffset: 0, placeholder: "2099-05-S001" }, // Code Master
    { column: "D", rowOffset: 1, placeholder: "G990001" }, // 原型No
  ],
  [
    { column: "F", rowOffset: 0, placeholder: "CASTING SV950" }, // Description
    { column: "F", rowOffset: 1, placeholder: "POLISH" }, // POLISH
    { column: "F", rowOffset: 2, placeholder: "RH/P+18KPG/P" }, // メッキ
    // ⚠⚠ `rowOffset: 3`（`F19`）は実物が空。**欄を作らない。**
    { column: "F", rowOffset: 4, placeholder: "Logo SILVER" }, // ロゴ
  ],
  [
    {
      column: "G",
      rowOffset: 0,
      placeholder: "(ダイヤモンド) STONE-A RD 1.0 MM *3 PCS(ABC)",
    }, // STONE（1 行のまま。値が長いので幅いっぱいに使う）
  ],
  [
    { column: "H", rowOffset: 0, placeholder: "#10" }, // Size
    { column: "I", rowOffset: 0, placeholder: "3" }, // QTY
    { column: "J", rowOffset: 0, placeholder: "PCS" }, // Unit
  ],
  [
    // ⚠ 実物の書き方（`d/m/yy`）。**打った文字がそのまま xlsx に出る**
    //   （日付に変換しない）ので、記入例が書き方の見本になる。
    { column: "K", rowOffset: 0, placeholder: "28/4/99" }, // SHIP DATE
    { column: "L", rowOffset: 0, placeholder: "XX 1234" }, // REMARK
  ],
];

/** 行をまたいだ全スロット。⚠ 見出しの `#n` を数えるのに使う（列ごとの総数が要る）。 */
const LINE_SLOTS: readonly LineSlot[] = LINE_ROWS.flat();

/** 明細の列の名前（`A14:L14` の印字）。⚠ 画面の見出しはこれ。 */
function lineHeadingOf(column: string): string {
  return SHEET_HEADINGS[`${column}14`] ?? column;
}

/**
 * 見出しの一覧（`LINE_SLOTS` と同じ並び）。
 *
 * ⚠⚠ **`#n` は並び順**。`rowOffset + 1` ではない（`F19` を飛ばすので `#4` は `rowOffset: 4`）。
 * ⚠ 1 行しか使わない列には番号を付けない（`Code` / `QTY` など）。
 */
function lineLabels(): string[] {
  const counts = new Map<string, number>();
  for (const slot of LINE_SLOTS) counts.set(slot.column, (counts.get(slot.column) ?? 0) + 1);
  const seen = new Map<string, number>();
  return LINE_SLOTS.map((slot) => {
    const n = (seen.get(slot.column) ?? 0) + 1;
    seen.set(slot.column, n);
    const base = lineHeadingOf(slot.column);
    return (counts.get(slot.column) ?? 0) > 1 ? `${base} #${n}` : base;
  });
}

/**
 * 工程表のセルの名前。`C4` → `"WAX Start"`。
 *
 * ⚠ `HEADER_FIELD_LABELS` に足さない。工程名は `B{行}`、Start/Stop/Day は `{列}3` にあり、
 *   **どちらも見出しなので、そこから組み立てれば対応表が 1 つ増えずに済む**。
 */
function planLabelOf(ref: string): string {
  const m = /^([CDE])(\d+)$/u.exec(ref);
  if (!m) return ref;
  return `${SHEET_HEADINGS[`B${m[2]}`] ?? ""} ${SHEET_HEADINGS[`${m[1]}3`] ?? ""}`.trim();
}

/** 工程表の記入例。⚠ Day だけ日数、ほかは日付。 */
function planPlaceholderOf(ref: string): string {
  return ref.startsWith("E") ? "2" : "9/16";
}

/** ヘッダの欄の見出し。⚠ `F5`（取引先名）は契約に無いので既定の文字にする。 */
function headerLabelOf(ref: string): string {
  return HEADER_FIELD_LABELS[ref] ?? (PLAN_CELLS.includes(ref) ? planLabelOf(ref) : "取引先");
}

/**
 * 番地 → 列と枠の中の位置。⚠ **表は持たない**（幾何から割る）。
 *
 * `order-sheets/lib/order-sheet-layout.ts` の `parseLineCellRef()` と同じ計算。
 * ⚠ 枠の外（見出し・ヘッダ・合計）は `null`。
 */
function parseLineRef(ref: string): { column: string; lineNo: number; rowOffset: number } | null {
  const m = /^([A-L])([1-9][0-9]{0,2})$/u.exec(ref);
  if (!m) return null;
  const fromFirst = Number(m[2]) - FIRST_BLOCK_ROW;
  if (fromFirst < 0) return null;
  const index = Math.floor(fromFirst / BLOCK_ROWS);
  if (index >= BLOCK_COUNT) return null;
  return {
    column: m[1]!,
    lineNo: index + 1,
    rowOffset: (fromFirst % BLOCK_ROWS) - VALUE_ROW,
  };
}

function headerFieldSpec(sheet: OrderSheet, ref: string, editable: boolean): FieldSpec {
  return {
    ref,
    scope: "header",
    label: headerLabelOf(ref),
    // ⚠ `F5` は契約に無い（派生）。`A12` と同じ `partners.name` を出す。
    placeholder: HEADER_PLACEHOLDERS[ref] ?? planPlaceholderOf(ref),
    field: sheet.header[ref] ?? (ref === "F5" ? (sheet.header.A12 ?? BLANK_CELL) : BLANK_CELL),
    editable,
    // ⚠ 写しの表から引く（番地を書き並べない）。`F5` と工程表には接頭辞が無い。
    prefix: HEADER_PREFIXES[ref],
  };
}

/**
 * ★★ 画面の区画と欄を組み立てる。
 *
 * @param ingesting 取り込み中。⚠⚠ **読み取りの結果でセルが入れ替わる最中に人が書くと、
 *   書いた値が上書きされて消える**ので、**1 欄も打たせない**。
 */
export function buildOrderSheetForm(sheet: OrderSheet, ingesting = false): OrderSheetForm {
  const labels = lineLabels();

  // 工程表（`C4:E10`)。⚠ 一覧は `PLAN_CELLS` から。番地を書き写さない。
  const productionPlan: SectionSpec = {
    id: "productionPlan",
    title: SECTION_TITLE.productionPlan,
    visible: SECTION_VISIBLE.productionPlan,
    fields: PLAN_CELLS.map((ref) => headerFieldSpec(sheet, ref, !ingesting)),
    lines: [],
  };

  // 紙の右上の 2 つ（`J5` / `J7`）。
  const shipCustomerPo: SectionSpec = {
    id: "shipCustomerPo",
    title: SECTION_TITLE.shipCustomerPo,
    visible: SECTION_VISIBLE.shipCustomerPo,
    fields: SHIP_CUSTOMER_PO_REFS.map((ref) => headerFieldSpec(sheet, ref, !ingesting)),
    lines: [],
  };

  /*
   * 残りのヘッダ。⚠ **導出**（工程表でも右上でもないもの）。
   *   ヘッダの番地を足したら、置き場所を決めなくてもここに出る。
   *   ⚠ 派生（`A12` / `J12` / `F5`）は打たせない。writer も同じ 3 つを捨てる。
   */
  const customerRefs = [
    ...HEADER_VALUE_CELLS.filter(
      (ref) => !PLAN_CELLS.includes(ref) && !SHIP_CUSTOMER_PO_REFS.includes(ref),
    ),
    ...DERIVED_HEADER_CELLS,
  ];
  const customer: SectionSpec = {
    id: "customer",
    title: SECTION_TITLE.customer,
    visible: SECTION_VISIBLE.customer,
    fields: customerRefs.map((ref) =>
      headerFieldSpec(sheet, ref, !ingesting && !DERIVED_HEADER_CELLS.includes(ref)),
    ),
    lines: [],
  };

  const orderSheet: SectionSpec = {
    id: "orderSheet",
    title: SECTION_TITLE.orderSheet,
    visible: SECTION_VISIBLE.orderSheet,
    fields: [],
    lines: buildLineCards(sheet, ingesting, labels),
  };

  // ⚠ 枠の数 = 明細のカードの数（xlsx も同じ数だけ枠を出す）。
  const totalRow = totalRowOf(orderSheet.lines.length);
  return {
    sections: [productionPlan, customer, shipCustomerPo, orderSheet],
    total: {
      label: "合計",
      unit: TOTAL_UNIT_TEXT,
      cell: `I${totalRow}`,
      unitCell: `J${totalRow}`,
    },
  };
}

function buildLineCards(sheet: OrderSheet, ingesting: boolean, labels: string[]): LineCardSpec[] {
  return (
    sheet.lines
      /*
       * ⚠⚠ **12 枠を超える明細はカードにしない。** 枠の外の番地は `isLineCellRef()` が偽で、
       *   API の `cellKeySchema` が弾く（保存ごと 400 になる）。⚠ 黙って消さない
       *   — 超える明細は xlsx を出すときに 422 で断る（`order-sheet-xlsx.ts`）。
       */
      .filter((line) => line.lineNo >= 1 && line.lineNo <= BLOCK_COUNT)
      .slice()
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((line) => {
        /*
         * ⚠ 取り込み中の仮の明細は `lineId` が空。**打たせない**（writer が捨てるので、
         *   打てても保存されず黙って消える）。
         */
        const editable = line.lineId.length > 0 && !ingesting;
        const covered = new Set<string>();

        // ⚠ 見出しの `#n` は行をまたいだ通し番号なので、平らにした添字で引く。
        let flat = 0;
        const rows = LINE_ROWS.map((slots) => {
          const row: FieldSpec[] = [];
          for (const slot of slots) {
            const label = labels[flat]!;
            flat += 1;
            const ref = cellRefOf(slot.column, line.lineNo, slot.rowOffset);
            // ⚠⚠ 門番。A 列 / E 列や枠の外を作ったら PATCH が 400 で落ちる。
            if (!isLineCellRef(ref)) continue;
            covered.add(ref);
            row.push({
              ref,
              scope: line.lineId,
              label,
              placeholder: slot.placeholder,
              field: line.cells[ref] ?? BLANK_CELL,
              editable,
            });
          }
          return row;
        }).filter((row) => row.length > 0);

        /*
         * ★★ 余りの欄。**一覧に無い番地に値が入っていたら、そのぶんも出す。**
         *
         * ⚠⚠ 実物が使っていないセル（`F19` や `B15` など）にも値が残っていることがある
         *   （API は枠の 60 セルどれにも書ける）。それらは D1 に残り、xlsx にも出る。**出さないと「保存され、xlsx にも出るのに画面に無い」**
         *   という、「xlsx にだけ出ない」の裏返しになる。
         * ⚠ 値が入っているものだけ。空のセルまで出すと 60 欄に逆戻りする。
         * ⚠ 決めてある 6 行の並びを崩さないよう、**最後の行**にまとめる。
         */
        const extra: FieldSpec[] = [];
        for (const ref of Object.keys(line.cells).sort()) {
          if (covered.has(ref) || !isLineCellRef(ref)) continue;
          const cell = line.cells[ref]!;
          if (cell.value === null || cell.value === "") continue;
          const at = parseLineRef(ref);
          if (at === null || at.lineNo !== line.lineNo) continue;
          extra.push({
            ref,
            scope: line.lineId,
            label: `${lineHeadingOf(at.column)}（枠の ${at.rowOffset + VALUE_ROW + 1} 行目）`,
            placeholder: "未入力",
            field: cell,
            editable,
          });
        }
        if (extra.length > 0) rows.push(extra);

        return {
          lineId: line.lineId,
          lineNo: line.lineNo,
          title: `明細 #${line.lineNo}`,
          qtyRef: qtyRefOf(line.lineNo),
          picture: {
            // ⚠ 見出しは実物の印字（`E14`）から引く。
            label: lineHeadingOf("E"),
            field: line.picture,
            photos: line.photos,
            fileId:
              line.picture.value === null || line.picture.value === undefined
                ? null
                : String(line.picture.value),
            deletable: editable,
          },
          rows,
        };
      })
  );
}

/*
 * ⚠ 明細の枠は 12 個まで。**超える明細は xlsx の出口が 422 で断る**（黙って消さない）。
 * ⚠⚠ `G7` / `I<合計>` は**雛形の数式**。画面は数字を出すだけで、**欄にしない**
 *   （`order-sheet-form.ts` の `computedCellsOf()` が一覧。値で上書きすると、人が Excel で
 *   明細を直したときに合計が追従しなくなる）。**欄になっていないこと**は
 *   `order-sheet-sections.test.ts` が固定する。
 */
