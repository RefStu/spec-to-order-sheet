import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  aiExtractionFields,
  aiExtractions,
  aiFieldCorrections,
  aiJobs,
} from "../../ai-review/db/schema";
import { LOW_CONFIDENCE_100 } from "../../ai-review/lib/extraction-fields";
import { partners } from "../../partners/db/schema";
import { staleBefore } from "../../../shared/ai-jobs";
import { createDb } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import {
  orderSheetLinePhotos,
  orderSheetLines,
  orderSheets,
} from "../db/schema";
import { parseCells, parseHeaderCells } from "../lib/cells";
import { sheetDateText, todayIsoDate } from "../lib/cell-text";
import {
  aiLineCellRefs,
  fieldOwner,
  ORDER_SHEET_FIELDS,
} from "../lib/order-sheet-fields";
import { EDITABLE_HEADER_CELLS } from "../lib/order-sheet-layout";
import { headerFieldKeys } from "../schema";
import type { Field, FieldValue, OrderSheet, OrderSheetStatus } from "../schema";

/**
 * ★ `GET /api/order-sheets/:caseId` の中身を D1 から組む。
 *
 * ⚠⚠ **`../schema.ts` の形を変えないこと。** 画面 (features/cases) が黙って壊れる。
 * ⚠⚠ **「どの欄が AI で、どの欄が人か」を画面に持たせないための仕掛け。**
 *   出どころを知っているのはここだけなので、**API が事実 (`filledBy`) を返し、画面は描くだけ**。
 * ⚠ **欄は 1 つも省かない。** 画面は `if (!field) return null` で飛ばすので、省くと
 *   「人が埋める空の欄」が画面から消える。**空で返すことに意味がある**。
 * ⚠ 確信度は DB が 0..100、API が 0..1。**ここで割る。**
 */

/** 画面の「確信度が低い」の閾値。**正は読み取り側の 1 か所だけ。** */
const CONFIDENCE_THRESHOLD = LOW_CONFIDENCE_100 / 100;

/** 取り込み中と見なすジョブの状態。**この間は明細の空の枠を見せる。** */
const INGESTING_STATUSES = ["queued", "running"] as const;

/**
 * 組み立て途中の欄。**`by` (本来どちらの欄か) はまだ入っていない。**
 * ⚠ `by` は欄の名前で決まるので、**最後に 1 か所でまとめて押す** (`stampOwners`)。
 *   欄ごとに書くと、足すたびに書き忘れが出る。
 */
type DraftField = Omit<Field, "by">;

function blank(): DraftField {
  return { value: null, filledBy: null, confidence: null, corrected: false, source: null };
}

/** 人が入れた欄。AI の記録が無く、値だけがある。 */
function human(value: FieldValue): DraftField {
  if (value === null || value === "") return blank();
  return { value, filledBy: "human", confidence: null, corrected: false, source: null };
}

/**
 * 欄の名前から `by` を押す。**正は `lib/order-sheet-fields.ts` の 1 か所。**
 *
 * ⚠ 画面に「AI が埋める 8 欄」の一覧を持たせないための仕掛け
 *   (持たせると API と 2 か所になり、必ずずれる)。
 */
function stampOwners(sheet: OrderSheet): OrderSheet {
  for (const [key, field] of Object.entries(sheet.header)) {
    field.by = fieldOwner(key);
  }
  for (const line of sheet.lines) {
    line.picture.by = fieldOwner("PICTURE");
    // ⚠ セルの鍵がそのまま欄の名前。一覧に無いセルは `fieldOwner()` が human を返す。
    for (const [key, field] of Object.entries(line.cells)) {
      field.by = fieldOwner(key);
    }
  }
  return sheet;
}

/**
 * セルの地図を画面の形にする。
 *
 * ⚠ 出すのは**値のあるセル**と**AI が埋めるセル**だけ。AI のセルは空でも出す
 *   (画面が「まだ埋まっていない」と分かるように)。残りは画面が空欄で並べる。
 */
function buildCells(
  lineId: string,
  lineIndex: number,
  stored: Record<string, string>,
  fieldOf: (table: string, rowId: string, column: string, value: FieldValue) => DraftField,
): Record<string, DraftField> {
  // ⚠ 番地は明細ごとに違う（`"D16"` / `"D22"` …）。空でも出す AI のセルもその明細のもの。
  const keys = new Set([...aiLineCellRefs(lineIndex), ...Object.keys(stored)]);
  const cells: Record<string, DraftField> = {};
  for (const key of keys) {
    cells[key] = fieldOf("order_sheet_lines", lineId, key, stored[key] ?? null);
  }
  return cells;
}

/**
 * ★ 取り込み中に見せる**空の明細 1 行**。
 *
 * ⚠⚠ **値はすべて空。** 画面は `by`(本来どちらの欄か) と `filledBy`(実際に誰が埋めたか) の
 *   組み合わせで「AI がまだ埋めていない欄」を見分けてスピナーを回す
 *   (`cases/lib/field-style.ts` の `fieldTone`)。**欄の一覧を画面に持たせないための形。**
 * ⚠ `lineId` は空文字。画面はこれを見て**読み取り専用**にする (保存に混ぜない)。
 */
function placeholderLine(): OrderSheet["lines"][number] {
  return {
    lineId: "",
    lineNo: 1,
    // ★ 代表の図。取り込み中はまだ 1 枚も無い。
    photos: [],
    picture: blank(),
    /*
     * ⚠ **AI が埋めるセルだけを空で並べる。** 画面はこれを見てスピナーを回す
     *   (`by: "ai"` なのに `filledBy: null` = まだ埋まっていない)。
     *   人のセルは載せない — 取り込み中に打てる欄ではないので。
     */
    cells: Object.fromEntries(aiLineCellRefs(0).map((ref) => [ref, blank()])),
  } as unknown as OrderSheet["lines"][number];
}

/**
 * その案件の読み取りがまだ走っているか (明細の空の枠を出すかどうか)。
 *
 * ⚠⚠ **取り残された行を「走っている」と数えない。** consumer ごと落ちると `running` の行が
 *   誰にも畳まれずに残り、明細が永遠に空の枠のままになる。しきい値の正は
 *   `shared/ai-jobs.ts` の `JOB_STALE_MS` (cases 側の `foldStale()` と同じ値を使う)。
 * ⚠ `started_at` は running になって初めて入るので、**状態ごとに見る列が違う**
 *   (queued は `queued_at`、running は `started_at`)。
 */
async function isIngesting(env: Bindings, caseId: string): Promise<boolean> {
  const cutoff = new Date(staleBefore());
  const [running] = await createDb(env)
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.caseId, caseId),
        inArray(aiJobs.status, [...INGESTING_STATUSES]),
        or(
          and(eq(aiJobs.status, "queued"), gt(aiJobs.queuedAt, cutoff)),
          and(eq(aiJobs.status, "running"), gt(aiJobs.startedAt, cutoff)),
        ),
      ),
    )
    .limit(1);
  return running !== undefined;
}

type FieldRow = {
  normalizedValue: string | null;
  confidence: number;
  pageNo: number | null;
};

/** 欄の記録を引くための鍵。 */
const keyOf = (table: string, rowId: string, column: string) => `${table}|${rowId}|${column}`;

/**
 * ORDER SHEET がまだ無い案件に返す空の枠。
 *
 * ⚠ **404 にしない。** シードで作った案件や、読み取りが終わる前に詳細画面を
 *   開いたときに起きる。形が同じなら画面は無改修で「まだ AI が埋めていない」と描ける。
 */
export function emptySheet(caseId: string, ingesting = false): OrderSheet {
  return stampOwners({
    caseId,
    orderSheetId: "",
    status: "draft",
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    /**
     * ⚠⚠ **`headerFieldKeys` を回すこと（番地を書き並べない）。** 
     *   工程表の 21 セルが入って 6 → 27 になった。べた書きのままだと、
     *   **契約には有るのに空の枠にだけ無い欄**ができて、画面が undefined を踏む。
     * ⚠ 回すのは `headerFieldKeys`（契約）であって `HEADER_CELLS` ではない
     *   — あちらには契約に入らない `F5`（取引先名）が居る。
     */
    header: Object.fromEntries(headerFieldKeys.map((ref) => [ref, blank()])),
    // ★ 取り込み中は**空の枠**を出す。0 行だと表そのものが画面に出ない。
    lines: ingesting ? [placeholderLine()] : [],
  } as unknown as OrderSheet);
}

export async function readOrderSheet(env: Bindings, caseId: string): Promise<OrderSheet> {
  const db = createDb(env);

  const [sheet] = await db
    .select({
      id: orderSheets.id,
      status: orderSheets.status,
      partnerId: orderSheets.partnerId,
      partnerName: partners.name,
      // ⚠ 人が確認していない仮の取引先は CUSTOMER に出さない (下の注記)。
      partnerActive: partners.isActive,
      /** ★ ヘッダの値の正。⚠ 物理の列はもう読まない。 */
      cellsJson: orderSheets.cellsJson,
    })
    .from(orderSheets)
    .leftJoin(partners, eq(partners.id, orderSheets.partnerId))
    .where(eq(orderSheets.caseId, caseId))
    .limit(1);

  if (!sheet) return emptySheet(caseId, await isIngesting(env, caseId));

  /*
   * ⚠⚠ **明細の値はすべて `cells_json`**（欄ごとの列をやめた）。
   *   物理の列 (`size_text` / `quantity` / …) は残っているが**もう読まない**。
   *   写真だけは文字ではないので `photo_file_id` のまま。
   */
  const lines = await db
    .select({
      id: orderSheetLines.id,
      lineNo: orderSheetLines.lineNo,
      photoFileId: orderSheetLines.photoFileId,
      cellsJson: orderSheetLines.cellsJson,
    })
    .from(orderSheetLines)
    .where(eq(orderSheetLines.orderSheetId, sheet.id))
    .orderBy(asc(orderSheetLines.lineNo));

  const lineIds = lines.map((line) => line.id);
  /*
   * ⚠ **石 (`order_sheet_line_stones`) と社内ID (`order_sheet_line_ids`) はもう引かない。**
   *   どちらも人が打つ 1 セルぶんの文字になったので `cells_json` の `"G:0"` / `"C:0"` にある。
   *   表は残してあるが書き手は居ない (`lib/order-sheet-fields.ts` に理由を書いた)。
   */
  const [photos] = await Promise.all([
    /*
     * ★ 代表の図。**1 明細に複数枚**あるので `fields` の隣に別の配列で返す。
     * ⚠⚠ **人が外したもの (`deleted_at`) は返さない。** 外したことを持っているのは
     *   この列だけで、`files` にも R2 の鍵にも人の判断は載っていない。
     * ⚠ 確信度も `filledBy` も持たせない。欄 (`PICTURE`) は 1 つのままなので塗り分けも 1 色。
     */
    lineIds.length === 0
      ? []
      : db
          .select({
            id: orderSheetLinePhotos.id,
            orderSheetLineId: orderSheetLinePhotos.orderSheetLineId,
            fileId: orderSheetLinePhotos.fileId,
            sortKey: orderSheetLinePhotos.sortKey,
          })
          .from(orderSheetLinePhotos)
          .where(
            and(
              inArray(orderSheetLinePhotos.orderSheetLineId, lineIds),
              isNull(orderSheetLinePhotos.deletedAt),
            ),
          )
          .orderBy(asc(orderSheetLinePhotos.sortKey)),
  ]);

  // ── AI が埋めた欄と、人が直した欄を一度に引く ────────────────────────
  // ⚠ 欄ごとに 1 本ずつ引くと D1 の往復が数十回になる。行 ID でまとめて引く。
  // ⚠ 石の行はもう来歴を持たない (セルになった)。引くのはシートと明細の行だけ。
  const rowIds = [sheet.id, ...lineIds];
  const [aiRows, correctionRows] = await Promise.all([
    db
      .select({
        targetTable: aiExtractionFields.targetTable,
        targetRowId: aiExtractionFields.targetRowId,
        targetColumn: aiExtractionFields.targetColumn,
        normalizedValue: aiExtractionFields.normalizedValue,
        confidence: aiExtractionFields.confidence,
        pageNo: aiExtractionFields.pageNo,
      })
      .from(aiExtractionFields)
      .innerJoin(aiExtractions, eq(aiExtractions.id, aiExtractionFields.aiExtractionId))
      // ⚠ **最新の版だけ。** やり直すと古い版が残るので、絞らないと古い確信度が出る。
      .where(
        and(inArray(aiExtractionFields.targetRowId, rowIds), eq(aiExtractions.isCurrent, true)),
      ),
    db
      .select({
        targetTable: aiFieldCorrections.targetTable,
        targetRowId: aiFieldCorrections.targetRowId,
        targetColumn: aiFieldCorrections.targetColumn,
      })
      .from(aiFieldCorrections)
      .where(inArray(aiFieldCorrections.targetRowId, rowIds)),
  ]);

  const aiByKey = new Map<string, FieldRow>();
  for (const row of aiRows) {
    if (!row.targetRowId) continue;
    aiByKey.set(keyOf(row.targetTable, row.targetRowId, row.targetColumn), row);
  }
  const correctedKeys = new Set(
    correctionRows
      .filter((row) => row.targetRowId)
      .map((row) => keyOf(row.targetTable, row.targetRowId!, row.targetColumn)),
  );

  /**
   * 1 つの欄を組む。**AI の記録があれば AI の欄、無くて値があれば人の欄、値も無ければ空。**
   * ⚠ ここが「誰が埋めたか」を答える唯一の場所 (画面は欄のキーから判断しない)。
   */
  function fieldOf(
    table: string,
    rowId: string,
    column: string,
    value: FieldValue,
    /** 石のように 1 欄が複数行から来るとき、確信度は一番低いものに合わせる。 */
    extraKeys: string[] = [],
  ): DraftField {
    const keys = [keyOf(table, rowId, column), ...extraKeys];
    let weakest: FieldRow | undefined;
    for (const key of keys) {
      const row = aiByKey.get(key);
      if (row && (!weakest || row.confidence < weakest.confidence)) weakest = row;
    }
    if (!weakest) return human(value);

    return {
      value,
      filledBy: "ai",
      // ⚠ DB は 0..100、API は 0..1。
      confidence: weakest.confidence / 100,
      corrected: keys.some((key) => correctedKeys.has(key)),
      source:
        weakest.pageNo === null
          ? null
          : // ⚠ bbox は取れない。モデルは座標を知らず、訊けば推測で答える。
            // 画面は source.page しか使っていない (OrderSheetField.tsx)。
            { page: weakest.pageNo, bbox: [0, 0, 0, 0] as [number, number, number, number] },
    };
  }

  /**
   * ★ ORDER SHEET の器はできたが明細がまだ 0 行 = 分類と読み取りの途中。
   *   **空の枠を 1 行出す** (0 行だと表そのものが画面に出ない)。
   * ⚠ 読み取りが終わって本当に 0 行のときは出さない (ジョブを見て決める)。
   */
  const showPlaceholder = lines.length === 0 && (await isIngesting(env, caseId));

  /** ⚠ 人が打つ 4 つだけ（`A12` と `J12` は派生なので地図には無い）。 */
  const headerCells = parseHeaderCells(sheet.cellsJson);

  return stampOwners({
    caseId,
    orderSheetId: sheet.id,
    status: sheet.status as OrderSheetStatus,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    header: {
      /**
       * ⚠⚠ **人が確認した取引先だけを出す。**
       *   取引先名は読み取っていないので、取り込みでは必ず仮の行 (`is_active = false`)
       *   になる。仮の行の名前を出すと「取引先不明」が CUSTOMER に並んでしまう。
       *   **空のほうが正しい**。人がマスタを整えれば出る。
       * ⚠ 値は取引先の**名前**。partner_id をそのまま出すと画面に ID が並ぶ。
       */
      A12: fieldOf(
        "order_sheets",
        sheet.id,
        ORDER_SHEET_FIELDS.customer.column,
        sheet.partnerActive ? (sheet.partnerName ?? null) : null,
      ),
      /**
       * ★★ 人が打つセルは**番地を書き並べず `EDITABLE_HEADER_CELLS` を回す**
       *   （`J5` / `J7` / `D12` / `F12` ＋ 工程表の `C4:E10`）。
       *
       * ⚠ `fieldOf()` は来歴が無ければ `human(value)` に落ちるので、
       *   来歴のある `J7`（AI が読む発注No）も、無い `D12` / `F12` / `J5` / 工程表も
       *   **これ 1 本で正しく出る**。
       * ⚠ PO と SO は**別の欄**。1 欄に詰め込むと、どちらが欠けているのか見えなくなる。
       * ⚠ SHIP(ヘッダ) は営業が決める欄。**AI は絶対に書かない**（来歴が無いので human になる）。
       */
      ...Object.fromEntries(
        EDITABLE_HEADER_CELLS.map((ref) => [
          ref,
          fieldOf("order_sheets", sheet.id, ref, headerCells[ref] ?? null),
        ]),
      ),
      /**
       * ⚠ DATE は**xlsx を出した日**（帳票から読み取った値ではない）。
       *   以前は画面が「未入力」の箱を手で描いていた（欄ですらなかった）。
       *   いまは欄として出すが、**人は打てない**（writer が捨てる）。
       * ⚠⚠ **`order_sheets.issued_on` を出さない**。以前は出していたが、
       *   xlsx の `J12` は**出した日**なので、画面と xlsx で**別の日付**になっていた。
       *   いまは「いま出したら入る日」を、xlsx と同じ書き方（`d/m/yy`。例: `28/4/99`）で出す。
       *   日付と書き方の正は `lib/cell-text.ts`（`todayIsoDate()` / `sheetDateText()`）。
       */
      J12: human(sheetDateText(todayIsoDate())),
    },
    lines: showPlaceholder
      ? [placeholderLine()]
      : lines.map((line, index) => {
          return {
            lineId: line.id,
            lineNo: line.lineNo,
            /*
             * ★ 代表の図の一覧 (画面の `‹ 1/3 ›`)。**`fields.PICTURE` は代表 1 枚のまま**で、
             *   ここはその内訳。⚠ 代表は `photo_file_id` が持つ (この配列の先頭と一致する)。
             */
            photos: photos
              .filter((photo) => photo.orderSheetLineId === line.id)
              .map((photo) => ({
                photoId: photo.id,
                fileId: photo.fileId,
                sortKey: photo.sortKey,
              })),
            /*
             * ★ Picture 欄 (E 列)。**セルの地図には入れない** — 文字ではなく絵なので。
             *   値は `files.id` (画面が `/api/files/:fileId/original` で取りに行く)。
             */
            picture: fieldOf(
              ORDER_SHEET_FIELDS.picture.table,
              line.id,
              ORDER_SHEET_FIELDS.picture.column,
              line.photoFileId,
            ),
            /*
             * ★★ 枠のセル。**鍵は xlsx の番地**（`"F16"`）で、値は `cells_json` にある。
             *
             * ⚠ 載せるのは「値のあるセル」と「AI が埋めるセル」だけ (空でも載せる)。
             *   残りは画面が `lineCellRefs()` で空欄として並べる。
             * ⚠ `fieldOf()` は AI の記録が無ければ人の欄として返すので、
             *   人が打ったセルはそのまま `filledBy: "human"` になる。
             */
            cells: buildCells(line.id, index, parseCells(line.cellsJson, index), fieldOf),
          };
        }),
  } as unknown as OrderSheet);
}

/*
 * ⚠⚠ **`withIssues()` は外した。**GET / PATCH / 写真削除の応答に
 *   `issues` は載らない。判定 (`approval.ts` の `collectIssues`) は**残っていて**、
 *   いまは承認 (`approveOrderSheet()`) だけが呼ぶ。戻すときはここに包みを足す。
 */
