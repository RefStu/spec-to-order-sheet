import { and, asc, eq } from "drizzle-orm";
import { aiFieldCorrections } from "../../ai-review/db/schema";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import { findFieldRecord } from "../../ai-review/services/extraction-recorder";
import { storeUploadedPhoto } from "../../files/services/upload-service";
import { createDb, insertInChunks, runBatch } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import {
  orderSheetIssues,
  orderSheetLinePhotos,
  orderSheetLines,
  orderSheets,
} from "../db/schema";
import { parseCells, parseHeaderCells, serializeCells } from "../lib/cells";
import { isHeaderCellRef, isLineCellRef, parseLineCellRef } from "../lib/order-sheet-layout";
import { toDbErrorKind } from "../lib/correction-kind";
import { fieldKeyOfWireKey, ORDER_SHEET_FIELDS } from "../lib/order-sheet-fields";
import type { ApproveResult, FieldValue, PatchOrderSheetInput } from "../schema";
import { collectIssues, judgeApproval } from "./approval";
import { readOrderSheet } from "./order-sheet-reader";

/**
 * 人が埋める欄の保存と、現場に流せるかの判定。
 *
 * ⚠⚠ **判定は `./approval.ts` の 1 か所だけが持つ** (重さの判断が変わったら
 *   あちらの表だけを直せば済むようにしてある)。ここには重さの判断を書かない。
 * ⚠ **AI の欄も人が直せる。** 直したら `ai_field_corrections` に 1 件 1 行で残す。
 *   これが正答率の分母になるので落とさないこと。
 * ⚠ **`ai_extraction_fields` の行は消さない。** 消すと分母が減って正答率が嘘になる。
 */

export class OrderSheetMissing extends Error {}
export class AlreadyReleased extends Error {}
/** その明細 / その写真がこの ORDER SHEET に無い (404)。 */
export class LinePhotoMissing extends Error {}

const asText = (value: FieldValue): string | null => {
  if (value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

/**
 * 人が埋める欄を保存する。
 *
 * ⚠ **CUSTOMER は保存しない。** 実体は `partner_id` なので、画面に出ている**名前**を
 *   書き戻すと参照が壊れる (取引先を直すのは案件側 `PATCH /api/cases/:caseId` の仕事)。
 */
export async function applyPatch(
  env: Bindings,
  input: { caseId: string; patch: PatchOrderSheetInput; actorUid: string },
) {
  const db = createDb(env);
  const { caseId, patch } = input;

  const [sheet] = await db
    .select({ id: orderSheets.id, status: orderSheets.status, cellsJson: orderSheets.cellsJson })
    .from(orderSheets)
    .where(eq(orderSheets.caseId, caseId))
    .limit(1);
  if (!sheet) throw new OrderSheetMissing(caseId);

  const now = new Date();

  // ── ヘッダ ──────────────────────────────────────────────────────────
  /*
   * ★★ ヘッダも**セルの地図**に畳み込む。
   *
   * ⚠⚠ **物理の列にはもう書かない**（`customer_po_no` / `po_no` / `so_no` / `ship_date`）。
   *   列は残っているが書き手が居ない（明細を `cells_json` にまとめたときと同じ扱い）。
   * ⚠ 受けるのは**人が打つセルだけ**（`J5` / `J7` / `D12` / `F12` ＋ 工程表の `C4:E10`）。
   *   ⚠⚠ **番地の一覧をここに持たない。** 門番は `isHeaderCellRef()` ＝ `HEADER_CELLS` からの
   *   導出なので、欄が増えてもこの関数は 1 文字も変わらない（4 → 25 になったが
   *   ここは無変更だった）。
   *   `A12`(CUSTOMER) は `partner_id` からの派生、`J12`(DATE) は出力日からの派生なので**捨てる**
   *   （黙って捨てると気づけないので、名指しで info を出す）。
   * ⚠ 空にされたセルは鍵ごと消す（地図を疎に保つ）。
   */
  const headerPatch = patch.header ?? {};
  const headerCells = parseHeaderCells(sheet.cellsJson);
  let headerTouched = false;
  for (const [key, value] of Object.entries(headerPatch)) {
    if (!isHeaderCellRef(key)) {
      console.info(`[order-sheets] ${key} はこの口では保存しません (case=${caseId})`);
      continue;
    }
    const text = asText(value);
    if (text === null || text.length === 0) delete headerCells[key];
    else headerCells[key] = text;
    headerTouched = true;
  }
  if (headerTouched) {
    await db
      .update(orderSheets)
      .set({ cellsJson: serializeCells(headerCells), updatedAt: now })
      .where(eq(orderSheets.id, sheet.id));
  }

  // ── 明細 ────────────────────────────────────────────────────────────
  for (const linePatch of patch.lines ?? []) {
    // ⚠ 取り込み中の**空の枠**は `lineId` が空文字。保存に混ぜない。
    if (linePatch.lineId.length === 0) continue;
    // ⚠ 存在確認とセルの地図を **1 回で**引く (行ごとに 2 往復しない)。
    const [line] = await db
      .select({
        id: orderSheetLines.id,
        lineNo: orderSheetLines.lineNo,
        cellsJson: orderSheetLines.cellsJson,
      })
      .from(orderSheetLines)
      .where(
        and(eq(orderSheetLines.id, linePatch.lineId), eq(orderSheetLines.orderSheetId, sheet.id)),
      )
      .limit(1);
    // ⚠ 他の案件の行を書き換えられないよう、この ORDER SHEET の行だけを受ける。
    if (!line) continue;

    /*
     * ★★ セルの地図に**差分を畳み込む**。
     *
     * ⚠⚠ **欄ごとの列にはもう書かない**。`size_text` / `quantity` /
     *   `order_sheet_line_stones` / `order_sheet_line_ids` といった書き分けが全部消えて、
     *   **どのセルも同じ 1 本の道**になった。
     * ⚠ **空にされたセルは鍵ごと消す**（地図を疎に保つ。`null` を溜めない）。
     * ⚠ 載っていない鍵は**触らない**。画面は打ったセルだけ送ってくるので、
     *   これだけで「人が入れた他のセルを消さない」が成り立つ。
     */
    const lineIndex = line.lineNo - 1;
    const cells = parseCells(line.cellsJson, lineIndex);
    let touched = false;
    for (const [key, value] of Object.entries(linePatch.cells)) {
      // ⚠ 契約 (zod) が弾いているはずだが、念のため。知らない番地を地図に入れない。
      if (!isLineCellRef(key)) {
        console.info(`[order-sheets] 知らないセルです: ${key}`);
        continue;
      }
      /*
       * ⚠⚠ **その明細の枠の番地かを見る。** 番地は行番号を含むので、
       *   別の明細の番地を送られると**別の行の値をこの行の地図に書いてしまう**。
       *   契約は「番地として正しいか」しか見ないので、行との対応はここでしか確かめられない。
       */
      if (parseLineCellRef(key)?.lineIndex !== lineIndex) {
        console.info(`[order-sheets] 明細 ${line.lineNo} の枠の外のセルです: ${key}`);
        continue;
      }
      const text = asText(value);
      if (text === null || text.length === 0) delete cells[key];
      else cells[key] = text;
      touched = true;
    }

    if (touched) {
      await db
        .update(orderSheetLines)
        .set({ cellsJson: serializeCells(cells), updatedAt: now })
        .where(eq(orderSheetLines.id, line.id));
    }
  }

  await recordCorrections(env, {
    orderSheetId: sheet.id,
    patch,
    actorUid: input.actorUid,
    at: now,
  });

  // 人が見はじめた印。`released` から巻き戻さない。
  if (sheet.status === "draft" || sheet.status === "ai_generated") {
    await db
      .update(orderSheets)
      .set({ status: "in_review", updatedAt: now })
      .where(eq(orderSheets.id, sheet.id));
  }

  return readOrderSheet(env, caseId);
}



/**
 * ★ 人が直した欄を 1 件 1 行で残す (正答率の分母)。
 *
 * ⚠ 語は DB の enum に写す (`lib/correction-kind.ts`)。素通しすると CHECK 違反で落ちる。
 * ⚠ 明細の行 ID をそのまま使う。石も社内ID もセルになったので別表を引かない。
 */
async function recordCorrections(
  env: Bindings,
  input: { orderSheetId: string; patch: PatchOrderSheetInput; actorUid: string; at: Date },
) {
  const corrections = input.patch.corrections ?? [];
  if (corrections.length === 0) return;
  const db = createDb(env);

  for (const correction of corrections) {
    /*
     * ⚠ 明細もヘッダも**番地がそのまま欄の名前**（`"D16"` / `"J7"`）。
     *   `fieldDefOf()` 1 本で引ける（以前は表が 2 つに分かれていた）。
     * ⚠ 一覧に無い欄 (Unit や継ぎ行や人だけのセル) は正答率に入らないので数えない。
     */
    const fieldKey = fieldKeyOfWireKey(correction.fieldKey);
    if (fieldKey === undefined) continue;
    const def = ORDER_SHEET_FIELDS[fieldKey];

    // ⚠ 石も社内ID もセルになったので、行 ID は**必ず明細の行**（別表を引かない）。
    const rowId = correction.lineId ?? input.orderSheetId;

    /*
     * ⚠⚠ **来歴に入れるのは「解決した後の住所」**（明細なら `"D16"`）。
     *   画面から来た `fieldKey` がまさにその番地なので、そのまま使えば
     *   `ai_extraction_fields` 側（`targetColumnOf()` が書いた値）と必ず一致する。
     */
    const targetColumn = correction.fieldKey;

    // AI の欄なら、どの記録を直したのかまで残す (原本まで辿れるように)。
    const source = await findFieldRecord(env, {
      table: def.table,
      rowId,
      column: targetColumn,
    });

    await db.insert(aiFieldCorrections).values({
      id: uuidv7(),
      aiExtractionFieldId: source?.id ?? null,
      aiJobId: null,
      targetTable: def.table,
      targetRowId: rowId,
      targetColumn,
      beforeValue: correction.previousValue === null ? null : String(correction.previousValue),
      afterValue: correction.newValue === null ? null : String(correction.newValue),
      errorKind: toDbErrorKind(correction.errorKind),
      correctedBy: input.actorUid,
      correctedAt: input.at,
    });
  }
}

/**
 * ★ 明細の代表の図を**1 枚だけ**外す (画面のゴミ箱)。
 *
 * ⚠⚠ **人が外した記録を持つのは `order_sheet_line_photos.deleted_at` だけ。**
 *   `files` は降ろさない — `matchBySpecNo` は 1 対多を許すので、1 枚の依頼書が複数の明細に
 *   結ばれる。`files` を降ろすと**関係のない明細の Picture まで消える**。R2 の鍵にも
 *   載せない (鍵は `(依頼書, 何枚目)` から導く冪等な式)。
 * ⚠⚠ **代表 (`order_sheet_lines.photo_file_id`) を必ず付け替える。** 付け替えないと、
 *   外した絵が Picture 欄に残る。残りが 0 枚なら空 (**全部外したら空が正しい**)。
 * ⚠ **二度目は何もしないで 200** (冪等)。画面の二度押しと、再送で 404 を出さないため。
 * ⚠ `ai_field_corrections` には**載せない**。欄は 1 つのままなので「直した」ではなく、
 *   載せると正答率の分母が枚数で水増しされる。
 */
export async function deleteLinePhoto(
  env: Bindings,
  input: { caseId: string; lineId: string; photoId: string },
) {
  const db = createDb(env);

  const [sheet] = await db
    .select({ id: orderSheets.id, status: orderSheets.status })
    .from(orderSheets)
    .where(eq(orderSheets.caseId, input.caseId))
    .limit(1);
  if (!sheet) throw new OrderSheetMissing(input.caseId);
  // ⚠ `released` は不可逆点。現場が動いているので根拠の絵も動かさない。
  if (sheet.status === "released") throw new AlreadyReleased(input.caseId);

  // ⚠ 他の案件の明細を触られないよう、この ORDER SHEET の行だけを受ける。
  const [line] = await db
    .select({ id: orderSheetLines.id })
    .from(orderSheetLines)
    .where(and(eq(orderSheetLines.id, input.lineId), eq(orderSheetLines.orderSheetId, sheet.id)))
    .limit(1);
  if (!line) throw new LinePhotoMissing(input.lineId);

  // ⚠ 消した行も引く (二度目かどうかをここで見分ける)。
  const photos = await db
    .select({
      id: orderSheetLinePhotos.id,
      fileId: orderSheetLinePhotos.fileId,
      deletedAt: orderSheetLinePhotos.deletedAt,
    })
    .from(orderSheetLinePhotos)
    .where(eq(orderSheetLinePhotos.orderSheetLineId, line.id))
    .orderBy(asc(orderSheetLinePhotos.sortKey));

  const target = photos.find((photo) => photo.id === input.photoId);
  if (!target) throw new LinePhotoMissing(input.photoId);

  if (target.deletedAt === null) {
    const now = new Date();
    // 残った先頭の絵が新しい代表。1 枚も残らなければ空。
    const head = photos.find((photo) => photo.deletedAt === null && photo.id !== target.id);
    // ⚠ **1 トランザクション。** 途中で割れると、消した絵が代表のまま欄に残る。
    await runBatch(db, [
      db
        .update(orderSheetLinePhotos)
        .set({ deletedAt: now })
        .where(eq(orderSheetLinePhotos.id, target.id)),
      db
        .update(orderSheetLines)
        .set({ photoFileId: head?.fileId ?? null, updatedAt: now })
        .where(eq(orderSheetLines.id, line.id)),
    ]);
  }

  // ⚠ 返すのは ORDER SHEET 全体 (`applyPatch` と同じ形)。画面はこれで締められる。
  return readOrderSheet(env, input.caseId);
}

/**
 * ★ 明細に代表の図を**1 枚足す** (画面の upload アイコン)。`deleteLinePhoto` と対。
 *
 * ⚠ AI がうまく切り出せなかったときに、人が差し替えるための口。
 * ⚠⚠ **可否を先に確かめてから預ける。** `released` や他の案件の明細なのに R2 と `files` を
 *   書くと、どこにも結ばれない絵が残る。
 * ⚠ 行は**末尾に足す** (`sort_key` = 消した行も含めた最大 + 1)。既にある並びを崩さない。
 * ⚠⚠ **代表は「生きている先頭」**(`deleteLinePhoto` と同じ規則)。生きている絵が無ければ
 *   足した絵が代表になる。行の無い古い明細も、ここで行の世界に揃う
 *   (画面と xlsx は行の先頭を見るので、代表の列だけ古い絵を指したままにしない)。
 * ⚠ `revision_request_id` は null (依頼書から来た絵ではない)。読み直しの generator は
 *   生きている行を消さないので、上げた絵は残る。
 * ⚠ `ai_field_corrections` には載せない (`deleteLinePhoto` と同じ理由)。
 */
export async function addLinePhoto(
  env: Bindings,
  input: {
    caseId: string;
    lineId: string;
    file: { filename: string; body: ArrayBuffer };
    actorUid: string;
  },
) {
  const db = createDb(env);

  const [sheet] = await db
    .select({ id: orderSheets.id, status: orderSheets.status })
    .from(orderSheets)
    .where(eq(orderSheets.caseId, input.caseId))
    .limit(1);
  if (!sheet) throw new OrderSheetMissing(input.caseId);
  if (sheet.status === "released") throw new AlreadyReleased(input.caseId);

  // ⚠ 他の案件の明細に付けられないよう、この ORDER SHEET の行だけを受ける。
  const [line] = await db
    .select({ id: orderSheetLines.id })
    .from(orderSheetLines)
    .where(and(eq(orderSheetLines.id, input.lineId), eq(orderSheetLines.orderSheetId, sheet.id)))
    .limit(1);
  if (!line) throw new LinePhotoMissing(input.lineId);

  const photos = await db
    .select({
      id: orderSheetLinePhotos.id,
      fileId: orderSheetLinePhotos.fileId,
      sortKey: orderSheetLinePhotos.sortKey,
      deletedAt: orderSheetLinePhotos.deletedAt,
    })
    .from(orderSheetLinePhotos)
    .where(eq(orderSheetLinePhotos.orderSheetLineId, line.id))
    .orderBy(asc(orderSheetLinePhotos.sortKey));

  // ⚠ 形式 (jpeg / png) と大きさはここで見る。断られたら何も書かない。
  const stored = await storeUploadedPhoto(env, {
    filename: input.file.filename,
    body: input.file.body,
    uploadedBy: input.actorUid,
  });

  const now = new Date();
  const sortKey = photos.reduce((max, photo) => Math.max(max, photo.sortKey + 1), 0);
  const head = photos.find((photo) => photo.deletedAt === null);
  // ⚠ **1 トランザクション。** 行だけ入って代表が付かない、を作らない。
  await runBatch(db, [
    db.insert(orderSheetLinePhotos).values({
      id: uuidv7(),
      orderSheetLineId: line.id,
      fileId: stored.fileId,
      revisionRequestId: null,
      sortKey,
      createdAt: now,
    }),
    db
      .update(orderSheetLines)
      .set({ photoFileId: head?.fileId ?? stored.fileId, updatedAt: now })
      .where(eq(orderSheetLines.id, line.id)),
  ]);

  return readOrderSheet(env, input.caseId);
}

/**
 * 現場に流せるかを判定し、通れば `released` にする。
 *
 * ⚠⚠ **`released` は不可逆点。** ここから先は工場が動いているので前の段へは戻せない。
 *   すでに `released` の ORDER SHEET は断る。
 * ⚠ 重さの判断は `./approval.ts` の 1 か所だけが持つ (後から変わりうるため)。
 */
export async function approveOrderSheet(
  env: Bindings,
  input: { caseId: string; actorUid: string },
): Promise<ApproveResult> {
  const db = createDb(env);

  const [sheet] = await db
    .select({ id: orderSheets.id, status: orderSheets.status })
    .from(orderSheets)
    .where(eq(orderSheets.caseId, input.caseId))
    .limit(1);
  if (!sheet) throw new OrderSheetMissing(input.caseId);
  if (sheet.status === "released") throw new AlreadyReleased(input.caseId);

  const current = await readOrderSheet(env, input.caseId);
  const issues = collectIssues(current);
  const { ok, blockers, warnings } = judgeApproval(issues);

  // 画面が「何が足りないか」を後からでも見られるよう、判定の結果を残す。
  const now = new Date();
  await db.delete(orderSheetIssues).where(eq(orderSheetIssues.orderSheetId, sheet.id));
  /*
   * ⚠⚠ **1 文にまとめない。** D1 の bind 変数は 1 文 100 個まで。この表は 7 列で、
   *   不整合は「ヘッダ 3 件 + 明細 3 件 × 行数」なので **5 明細で 18 件 = 126 個**になり超える。
   *   6 欄すべてが warning なので**件数が減らず**、効きやすい。
   */
  await insertInChunks(
    issues.map((issue) => ({
      id: uuidv7(),
      orderSheetId: sheet.id,
      orderSheetLineId: issue.lineId,
      // ⚠ approval.ts の kind は order_sheet_issues.kind の enum に収まっている。
      kind: issue.kind as "ship_date_missing",
      severity: issue.severity,
      message: issue.message,
      createdAt: now,
    })),
    (chunk) => db.insert(orderSheetIssues).values(chunk),
  );

  if (!ok) return { ok, status: current.status, blockers, warnings };

  await db
    .update(orderSheets)
    .set({ status: "released", releasedBy: input.actorUid, releasedAt: now, updatedAt: now })
    .where(eq(orderSheets.id, sheet.id));

  return { ok, status: "released", blockers, warnings };
}
