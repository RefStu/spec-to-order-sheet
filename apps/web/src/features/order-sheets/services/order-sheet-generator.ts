import { and, asc, eq, gt, inArray, isNull, like, or } from "drizzle-orm";
import type { FieldRecord } from "../../ai-review/lib/extraction-fields";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import { findFieldRecord } from "../../ai-review/services/extraction-recorder";
import { createDb, insertInChunks, type Db } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { files } from "../../files/db/schema";
import { parsePhotoStorageKey, photoStorageKeyPrefix } from "../../files/services/upload-service";
import { purchaseOrderLines, purchaseOrders } from "../../purchase-orders/db/schema";
import { DEFAULT_UNIT, UNKNOWN_QUANTITY } from "../../purchase-orders/services/po-writer";
import { revisionRequestSpecs, revisionRequests } from "../../revisions/db/schema";
import { orderSheetLinePhotos, orderSheetLines, orderSheets } from "../db/schema";
import { parseCells, parseHeaderCells, serializeCells } from "../lib/cells";
import { formatCodeMasterText } from "../lib/code-master";
import { isHeaderCellRef, lineCellRef } from "../lib/order-sheet-layout";
import { descriptionPrefix } from "../lib/description-text";
import { ORDER_SHEET_FIELDS, targetColumnOf } from "../lib/order-sheet-fields";
import { formatSizeText } from "../lib/size-text";
import { applyAiLinks, matchBySpecNo } from "../lib/spec-no";

/**
 * 単位 (J 列) のセル。
 *
 * ⚠ `ORDER_SHEET_FIELDS` には**入れていない** — AI が埋める欄ではないので、入れると
 *   正答率の分母が 8 から動く。だから鍵をここで作る (`lib/order-sheet-fields.ts` の Unit の節)。
 */
/** 単位のセルの列。⚠ 番地は明細ごとに解決する（`lineCellRef("J", index)`）。 */
const UNIT_COLUMN = "J";

/**
 * ★★ AI が埋める**ヘッダのセル**の番地（いまは Customer PO の `J7` だけ）。
 *
 * ⚠⚠ **一覧を書かない。** `ORDER_SHEET_FIELDS` から「`order_sheets` の欄で、AI が埋めて、
 *   かつ**セルの番地**であるもの」を選ぶ。CUSTOMER（`partner_id`）はセルではないので
 *   自然に外れる。
 * ⚠⚠ **べた書きにすると、AI の欄が増えたときにまた同じ穴が開く。**
 *   ヘッダの値を物理列から `cells_json` へ移したとき、reader / PATCH writer /
 *   xlsx / migration は直したのに**ここだけ直し忘れ**、`J7` は
 *   「`purchase_orders` にも `ai_extraction_fields` にも確信度 95 で入っているのに
 *   画面には出ない」状態だった（実データで発見）。
 *   ⚠ 一覧に載ったのに値を渡し忘れたら、下の `aiHeaderCells` の検査が名指しで落とす。
 */
const AI_HEADER_CELL_REFS: readonly string[] = Object.values(ORDER_SHEET_FIELDS)
  .filter((def) => def.table === "order_sheets" && def.by === "ai" && isHeaderCellRef(def.column))
  .map((def) => def.column);

/**
 * ★★ 案件 1 件から ORDER SHEET を 1 枚起こす。**PoC の山。**
 *
 * ⚠⚠ **AI が書くのは 10 欄だけ。** どれかは `lib/order-sheet-fields.ts` の
 *   `ORDER_SHEET_FIELDS` が唯一の正。`by: "human"` の列 (Code / ID / PO・SO /
 *   SHIP(ヘッダ)) には**絶対に書かない**。
 *   「**埋まらない欄がある方が正しい**」。
 * ⚠⚠ **Ship date(明細) と SHIP(ヘッダ) は別物。** 明細は発注書に印字されているので写すが、
 *   ヘッダの `order_sheets.ship_date` は営業が決める欄。**AI はヘッダの SHIP を待たない。**
 * ⚠ **CUSTOMER は必ず空になる。** 取引先名を読み取っていないため。
 * ⚠ **欄の定義 (`order-sheet-fields.ts`) に無い欄は作らない** (原型No / 工程表は人のセル)。
 *   ⚠ STONE / POLISH / メッキ / ロゴは人の欄だが、依頼書の**下部のメモ**があれば
 *   **空のセルにだけ**入れる (**将来は消す** — `fillFromSpecNote()`)。
 * ⚠ **冪等。** アップロードは PDF 1 枚 = 1 POST なので、案件 1 件ぶんの一式でも読み取りジョブは
 *   数本に分かれる。どれが最後でも同じ 1 枚に収束するよう upsert にしてある。
 *   **人が入れた欄 (item_code_text / po_no / so_no / ship_date) は触らない。**
 * ⚠ 確信度は**転記元から引き継ぐ**。転記で新しい確信度は生まれない。
 */

export interface GenerateResult {
  orderSheetId: string;
  lineCount: number;
  /** 欄ごとの記録。**欄 1 つ = 1 行。** */
  fields: FieldRecord[];
  /** `ai_extraction_payloads.raw_output` に残す、組み立ての根拠。 */
  rawOutput: string;
}

/** まだ組めない (発注書が 1 通も読めていない)。失敗ではないので retry しない。 */
export class OrderSheetNotGeneratable extends Error {}

export async function generateOrderSheet(
  env: Bindings,
  input: { caseId: string; aiJobId: string },
): Promise<GenerateResult> {
  const db = createDb(env);
  const now = new Date();
  const fields: FieldRecord[] = [];

  // ── 読む ──────────────────────────────────────────────────────────────
  const orders = await db
    .select({
      id: purchaseOrders.id,
      partnerId: purchaseOrders.partnerId,
      customerPoNo: purchaseOrders.customerPoNo,
      orderedOn: purchaseOrders.orderedOn,
    })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.caseId, input.caseId), isNull(purchaseOrders.deletedAt)))
    .orderBy(asc(purchaseOrders.id));

  // ⚠ 依頼書だけ先に読み終わった瞬間にも呼ばれる。**失敗ではない。**
  if (orders.length === 0) throw new OrderSheetNotGeneratable("no_purchase_order");
  const primary = orders[0]!;

  const poLines = await db
    .select({
      id: purchaseOrderLines.id,
      lineNo: purchaseOrderLines.lineNo,
      purchaseOrderId: purchaseOrderLines.purchaseOrderId,
      rawModelNo: purchaseOrderLines.rawModelNo,
      rawProductName: purchaseOrderLines.rawProductName,
      rawSizeText: purchaseOrderLines.rawSizeText,
      quantity: purchaseOrderLines.quantity,
      remark: purchaseOrderLines.remark,
    })
    .from(purchaseOrderLines)
    .where(
      inArray(
        purchaseOrderLines.purchaseOrderId,
        orders.map((row) => row.id),
      ),
    )
    .orderBy(asc(purchaseOrderLines.purchaseOrderId), asc(purchaseOrderLines.lineNo));

  // ⚠ **依頼書が付かない案件のほうが多い** (依頼書が併走する様式は一部だけ)。
  //   0 件でも先へ進む。付かない案件は発注書だけで 8 欄が埋まる。
  const revisions = await db
    .select({
      id: revisionRequests.id,
      specNo: revisionRequests.specNo,
      // ⚠ 製造番号が印字されていない明細を結ぶための予備の鍵 (2 巡目の突き合わせ)。
      productName: revisionRequests.productionName,
      /**
       * ★ 読み取りのときに ai が当てた対応づけ (規則で結べなかったぶんだけ入っている)。
       * ⚠ 規則 (`matchBySpecNo`) が結べるものは下でそのまま結ばれる。ここは**埋め草**。
       */
      purchaseOrderLineId: revisionRequests.purchaseOrderLineId,
      specId: revisionRequestSpecs.id,
      // ★ 実物の ORDER SHEET では Description が「区分 + 品位」(例: `CASTING SV950`)。
      purityText: revisionRequestSpecs.purityText,
      // ⚠ 表題の下の区分は `remark` に入っている (spec-writer.ts。専用の列が無いため)。
      requestCategoryText: revisionRequestSpecs.remark,
      // ★ 下部のメモ (**将来は消す**)。使うのは `fillFromSpecNote()` だけ。
      noteSizeText: revisionRequestSpecs.noteSizeText,
      noteStoneText: revisionRequestSpecs.noteStoneText,
      noteDescription2: revisionRequestSpecs.noteDescription2,
      noteDescription3: revisionRequestSpecs.noteDescription3,
      noteDescription4: revisionRequestSpecs.noteDescription4,
    })
    .from(revisionRequests)
    .leftJoin(revisionRequestSpecs, eq(revisionRequestSpecs.revisionRequestId, revisionRequests.id))
    .where(and(eq(revisionRequests.caseId, input.caseId), isNull(revisionRequests.deletedAt)));

  // ── 製造番号で突き合わせる ────────────────────────────────────────
  // ⚠ **依頼書は枚ごとに製造番号が違う** (= 明細ごとに 1 枚) ので 1 対 1 で足りる。
  // ⚠ 結びつかなかった明細も**行は作る** (空のまま先へ進める)。
  const byRule = matchBySpecNo({
    lines: poLines.map((line) => ({
      lineId: line.id,
      rawModelNo: line.rawModelNo,
      rawProductName: line.rawProductName,
    })),
    revisions: revisions.map((r) => ({
      revisionRequestId: r.id,
      specNo: r.specNo,
      productName: r.productName,
    })),
  });

  /*
   * ★ 規則で結べなかった明細にだけ、**読み取りのときに保存した ai の対応づけ**をかぶせる。
   *
   * ⚠⚠ **縛り (規則が勝つ / 依頼書を使い回さない / null は何もしない) は `applyAiLinks` が
   *   持つ。** ここで書き直すと正が 2 か所になるので、**同じ関数に渡す**。
   * ⚠ `applyAiLinks` は番号の**意味**を決めない (開くのは渡した関数)。ここでは
   *   `lineNo` も `specSheetIndex` も「`revisions` の何番目か」にしてある
   *   (`lineNo` は 1 始まりでないと弾かれる)。
   * ⚠ 列が空の依頼書しか無ければ、`byRule` がそのまま通る (いままでの挙動)。
   */
  const poLineIds = new Set(poLines.map((line) => line.id));
  const { matches } = applyAiLinks(
    byRule,
    revisions.flatMap((r, index) =>
      r.purchaseOrderLineId === null
        ? []
        : [{ lineNo: index + 1, specSheetIndex: index, confidence: 100 }],
    ),
    (lineNo) => {
      const stored = revisions[lineNo - 1]?.purchaseOrderLineId ?? null;
      // ⚠ 明細が消えている (読み直しで減った) ことがあるので、いまある明細だけに当てる。
      return stored !== null && poLineIds.has(stored) ? stored : null;
    },
    (index) => revisions[index]?.id ?? null,
  );
  const revisionIdByLine = new Map(matches.map((m) => [m.lineId, m.revisionRequestId]));
  const revisionById = new Map(revisions.map((r) => [r.id, r]));

  /**
   * ★ 代表の図。**依頼書の ID から決まる保存先の鍵の接頭辞**で引く
   *   (`photoStorageKeyPrefix`)。
   *
   * ⚠ `files` に「どの帳票から来たか」の列が無いので、鍵を橋にしている。
   *   切り出せなかった依頼書はここに 1 行も無い = 写真の欄は空のまま。
   * ⚠ **1 依頼書に複数枚**あるので `inArray(鍵)` ではなく `like(接頭辞)` で引き、
   *   `parsePhotoStorageKey()` で「何枚目か」に開く (鍵の式は 1 か所だけが持つ)。
   * ⚠ `sha256` も引く。**人が外した絵の墓標**は `file_id` の一致だけでは足りない
   *   (読み取りをやり直すと `revisionRequestId` ごと作り直されて `file_id` が変わる)。
   */
  const photoFiles =
    revisions.length === 0
      ? []
      : await db
          .select({ id: files.id, storageKey: files.storageKey, sha256: files.sha256 })
          .from(files)
          .where(
            and(
              or(
                ...revisions.map((r) => like(files.storageKey, `${photoStorageKeyPrefix(r.id)}%`)),
              ),
              isNull(files.deletedAt),
            ),
          );

  /** 依頼書 -> 切り出せた絵 (**何枚目**の順)。 */
  const photosByRevision = new Map<string, LinePhotoCandidate[]>();
  for (const file of photoFiles) {
    const parsed = parsePhotoStorageKey(file.storageKey);
    // ⚠ 接頭辞が別のものに当たっても、鍵の形と依頼書の一致でここで落ちる。
    if (!parsed || !revisionById.has(parsed.revisionRequestId)) continue;
    const list = photosByRevision.get(parsed.revisionRequestId) ?? [];
    list.push({ fileId: file.id, sha256: file.sha256, pictureIndex: parsed.pictureIndex });
    photosByRevision.set(parsed.revisionRequestId, list);
  }
  for (const list of photosByRevision.values()) {
    list.sort((a, b) => a.pictureIndex - b.pictureIndex);
  }

  // ── ヘッダ (CUSTOMER / CUSTOMER PO・NO) ────────────────────────────────
  const [existing] = await db
    .select({
      id: orderSheets.id,
      status: orderSheets.status,
      // ⚠⚠ **必ず読んでから重ねる**（下の `headerCells`）。読まずに書くと人の入力が消える。
      cellsJson: orderSheets.cellsJson,
    })
    .from(orderSheets)
    .where(eq(orderSheets.caseId, input.caseId))
    .limit(1);

  const orderSheetId = existing?.id ?? uuidv7();
  const totalQuantity = poLines.reduce((sum, line) => sum + (line.quantity ?? 0), 0);
  const customerPoNo = primary.customerPoNo.length > 0 ? primary.customerPoNo : null;

  /*
   * ★★ **AI が埋めるヘッダのセルだけを上書きする。**（明細側とまったく同じ形。下の `aiCells`）
   *
   * ⚠⚠ **人が打ったセルは 1 つも触らない。** 同じ地図に SHIP(`J5`) / PO(`D12`) /
   *   SO(`F12`) と工程表の 21 セル(`C4:E10`) が同居している。
   *   **読んでから AI の鍵だけ差し替える**ので、読み直しでそれらが消えることはない。
   * ⚠ 読めなかったセルは**鍵ごと消す**（`null` を溜めない）。
   * ⚠⚠ **物理列 `customer_po_no` は reader が見ていない**。
   *   列は残してあるが、画面と xlsx が読むのは**この `cells_json` のほう**。
   */
  const headerCells = parseHeaderCells(existing?.cellsJson);
  const aiHeaderCells: Record<string, string | null> = {
    [ORDER_SHEET_FIELDS.customerPoNo.column]: customerPoNo,
  };
  for (const ref of AI_HEADER_CELL_REFS) {
    // ⚠ 静かに欠けさせない（欠けると「読めているのに画面に出ない」に戻る）。
    if (!(ref in aiHeaderCells)) {
      throw new Error(`[order-sheets] AI が埋めるヘッダ ${ref} の値がここに渡されていません`);
    }
  }
  for (const [ref, value] of Object.entries(aiHeaderCells)) {
    if (value === null || value.length === 0) delete headerCells[ref];
    else headerCells[ref] = value;
  }

  const header = {
    partnerId: primary.partnerId,
    purchaseOrderId: primary.id,
    // ⚠ 列は残してあるが**誰も読まない**。正は下の `cellsJson`。
    customerPoNo,
    cellsJson: serializeCells(headerCells),
    // ⚠ NOT NULL。発注日が読めなければ今日を入れて先へ進める (空にできないと 1 行も書けない)。
    issuedOn: primary.orderedOn ?? isoDate(now),
    totalQuantity,
    // ⚠ 合計の単位も固定値 (読み取りではない)。
    totalUnitCode: DEFAULT_UNIT,
    generatedBy: "ai" as const,
    sourceAiJobId: input.aiJobId,
    updatedAt: now,
  };

  if (!existing) {
    await db.insert(orderSheets).values({
      id: orderSheetId,
      caseId: input.caseId,
      status: "ai_generated",
      ...header,
      createdAt: now,
    });
  } else {
    await db
      .update(orderSheets)
      .set({
        ...header,
        // ⚠ 人が見はじめた後 (in_review 以降) は状態を巻き戻さない。
        ...(existing.status === "draft" ? { status: "ai_generated" as const } : {}),
      })
      .where(eq(orderSheets.id, orderSheetId));
  }

  pushInherited(fields, await sourceOf(env, "purchase_orders", primary.id, "partner_id"), {
    table: ORDER_SHEET_FIELDS.customer.table,
    rowId: orderSheetId,
    column: ORDER_SHEET_FIELDS.customer.column,
    value: header.partnerId,
  });
  pushInherited(fields, await sourceOf(env, "purchase_orders", primary.id, "customer_po_no"), {
    table: ORDER_SHEET_FIELDS.customerPoNo.table,
    rowId: orderSheetId,
    column: ORDER_SHEET_FIELDS.customerPoNo.column,
    value: header.customerPoNo,
  });

  // ── 明細 (Code master / Description / Stone / Size / QTY / REMARK / Picture) ──
  for (const [index, line] of poLines.entries()) {
    const lineNo = index + 1;
    const [existingLine] = await db
      .select({
        id: orderSheetLines.id,
        cellsJson: orderSheetLines.cellsJson,
        photoFileId: orderSheetLines.photoFileId,
      })
      .from(orderSheetLines)
      .where(
        and(eq(orderSheetLines.orderSheetId, orderSheetId), eq(orderSheetLines.lineNo, lineNo)),
      )
      .limit(1);
    const lineId = existingLine?.id ?? uuidv7();

    const revision = revisionById.get(revisionIdByLine.get(line.id) ?? "");
    const description = buildDescription(revision);

    // ★ Code master は **依頼書の仕様書No**、無ければ**発注書の製造番号** (実物で確認した)。
    // ⚠ **2 段目 (原型番号) は入れない。** 人のセル (`D17`)。
    // ⚠⚠ **ここで整えるのは ORDER SHEET に載せる文字だけ** (`formatCodeMasterText`)。
    //   升目の印字を読むと `2099 - 12 - S002` のように空白が挟まることがある。
    //   **読み取りの記録 (spec_no / raw_model_no / quote) は印字そのまま**で、
    //   **突き合わせの鍵も `normalizeSpecNo()` のまま**。ここは見た目だけの話。
    const codeMaster = formatCodeMasterText(revision?.specNo ?? line.rawModelNo);
    const sizeText = formatSizeText(line.rawSizeText);

    /*
     * ★ 代表の図。**1 明細に複数枚**持てる (`order_sheet_line_photos`)。
     * ⚠ 行を入れるのは**明細を書いたあと** (FK が明細を指している) なので、ここでは
     *   「何を入れるか」と「代表は誰か」を決めるだけにする。
     */
    const photoPlan = await planLinePhotos(db, {
      lineId,
      isNewLine: !existingLine,
      revisionRequestId: revision?.id ?? null,
      candidates: revision ? (photosByRevision.get(revision.id) ?? []) : [],
      now,
    });

    /*
     * ★★ **AI が埋めるセルだけを上書きする。**
     *
     * ⚠⚠ **人が打ったセルは 1 つも触らない。** 以前は欄ごとの列に書いていて、
     *   `item_code_text` / `ship_date` / `unit_code` / `photo_file_id` のそれぞれに
     *   「読み直しで人の値を消さない」注意書きが要った。セルの地図になったいまは、
     *   **AI の鍵だけを差し替えて残りをそのまま持ち越す**の 1 本で済む。
     * ⚠ 読めなかったセルは**鍵ごと消す**（`null` を溜めない）。⚠ REMARK だけは例外 (下)。
     */
    const cells = parseCells(existingLine?.cellsJson, index);
    const aiCells: Record<string, string | null> = {
      // ★ Code master は依頼書の仕様書No。⚠ 原型No (`"D17"`) は人のセルなので触らない。
      [targetColumnOf("codeMaster", index)]: codeMaster,
      // ⚠ 3 行目以降 (POLISH・メッキ・ロゴ) は人のセル。ここは値の行だけ。
      [targetColumnOf("description", index)]: description.text,
      // ⚠ 実物は指輪の号数に `#` が付く。**数字だけの印字のときだけ**付ける
      //   (`45cm` のような長さには付けない)。⚠ 人が直した値には通さない。
      [targetColumnOf("size", index)]: sizeText,
      // ⚠ 読めなかった明細も作れるように既定値を入れる (po-writer.ts と同じ値を使う)。
      [targetColumnOf("qty", index)]: String(line.quantity ?? UNKNOWN_QUANTITY),
      // ⚠⚠ **Ship date は書かない。** 出どころが確定できないので読み取りをやめた
      //   (人が画面で入れる)。ここに戻すと、人が入れた出荷日が読み直しで消える。
    };
    for (const [key, value] of Object.entries(aiCells)) {
      if (value === null || value.length === 0) delete cells[key];
      else cells[key] = value;
    }
    /*
     * ★ REMARK。⚠⚠ **読めなかったときは鍵を消さない** (Picture と同じ守り方)。
     *   AI が null を返すことは多いので、消すと**人が画面で入れた Remark が読み直しで消える**。
     *   値が返ったときは上書きする (読み直しで直った値が入るように)。
     * ⚠ 同じ扱いを Size / QTY / Description に広げるかは別の話 (ここではやらない)。
     */
    if (line.remark) cells[targetColumnOf("remark", index)] = line.remark;
    // ★ 下部のメモ (**将来は消す**)。⚠ AI のセルを書いた**後**に重ねる
    //   (Size は発注書が空のときだけ、人のセルは空のときだけ埋める)。
    const noteSize = fillFromSpecNote(cells, index, revision);
    /*
     * ⚠⚠ **単位は新しい明細を作るときだけ入れる。** 読み取りの値ではないので、
     *   毎回書くと**読み直しのたびに人が直した Unit が消える**（写真と同じ罠）。
     */
    if (!existingLine) cells[lineCellRef(UNIT_COLUMN, index, 0)] = DEFAULT_UNIT;

    const aiColumns = {
      cellsJson: serializeCells(cells),
      /*
       * ★ **代表の 1 枚** (Picture 欄)。⚠ セルではないので列のまま。
       *
       * ⚠⚠ **写真の行が 1 つでもあれば「生きている先頭」が代表。** 人が全部外したら
       *   **空になるのが正しい** (外した絵を欄に残さない)。
       * ⚠⚠ **1 行も無いときは null で上書きしない。** 枠は毎回取れるとは限らない
       *   (取れないほうが多い)。無条件に書くと、**前の読み取りで取れていた写真が
       *   読み直しのたびに消える** (実データで、写真が R2 に 3 枚あるのに明細が
       *   全部 NULL になっていた)。
       */
      photoFileId: photoPlan.hasRows
        ? photoPlan.representative
        : (existingLine?.photoFileId ?? null),
      revisionRequestId: revisionIdByLine.get(line.id) ?? null,
      updatedAt: now,
    };

    if (!existingLine) {
      await db.insert(orderSheetLines).values({
        id: lineId,
        orderSheetId,
        lineNo,
        ...aiColumns,
        createdAt: now,
      });
    } else {
      await db.update(orderSheetLines).set(aiColumns).where(eq(orderSheetLines.id, lineId));
    }

    // ⚠ **明細の行を書いたあとで入れる** (FK cascade が明細を指している)。
    // ⚠ 既にある行は触らない (`sort_key` を保つ)。生きている行も消さない。
    if (photoPlan.inserts.length > 0) {
      await insertInChunks(photoPlan.inserts, (chunk) =>
        db.insert(orderSheetLinePhotos).values(chunk),
      );
    }

    // ⚠ Code master の確信度は**実際に採った側**から引き継ぐ。
    pushInherited(
      fields,
      revision?.specNo
        ? await sourceOf(env, "revision_requests", revision.id, "spec_no")
        : await sourceOf(env, "purchase_order_lines", line.id, "raw_model_no"),
      {
        table: ORDER_SHEET_FIELDS.codeMaster.table,
        rowId: lineId,
        column: targetColumnOf("codeMaster", index),
        value: codeMaster,
      },
    );

    // Description は複数の帳票から合成されるので、**一番低い確信度に合わせる**。
    const descriptionSource = await weakestOf(env, description.sources);
    pushInherited(fields, descriptionSource, {
      table: ORDER_SHEET_FIELDS.description.table,
      rowId: lineId,
      column: targetColumnOf("description", index),
      value: description.text,
    });

    // ⚠ Size の確信度は**実際に採った側**から引き継ぐ (メモで埋めたならメモの欄)。
    pushInherited(
      fields,
      noteSize && revision?.specId
        ? await sourceOf(env, "revision_request_specs", revision.specId, "note_size_text")
        : await sourceOf(env, "purchase_order_lines", line.id, "raw_size_text"),
      {
        table: ORDER_SHEET_FIELDS.size.table,
        rowId: lineId,
        column: targetColumnOf("size", index),
        value: noteSize ?? sizeText,
      },
    );
    pushInherited(fields, await sourceOf(env, "purchase_order_lines", line.id, "quantity"), {
      table: ORDER_SHEET_FIELDS.qty.table,
      rowId: lineId,
      column: targetColumnOf("qty", index),
      // ⚠ 来歴は**そのセルに入れた値**を残す（数量は 0 のこともある）。
      value: cells[targetColumnOf("qty", index)] ?? null,
    });
    pushInherited(fields, await sourceOf(env, "purchase_order_lines", line.id, "remark"), {
      table: ORDER_SHEET_FIELDS.remark.table,
      rowId: lineId,
      column: targetColumnOf("remark", index),
      value: line.remark,
    });
    /*
     * ★ 写真は**依頼書の代表の図の枠**から切り出したもの。確信度はその枠のもの。
     * ⚠ **代表が今回新しく入ったときだけ記録する。** 前の読み取りから引き継いだ写真や、
     *   人が外した結果として繰り上がった絵に今回の確信度を付けると、別の版の枠の
     *   確信度になってしまう。
     */
    if (revision && aiColumns.photoFileId && photoPlan.freshFileIds.has(aiColumns.photoFileId)) {
      pushInherited(
        fields,
        await sourceOf(env, "revision_request_specs", revision.specId ?? "", "purity_text"),
        {
          table: ORDER_SHEET_FIELDS.picture.table,
          rowId: lineId,
          column: ORDER_SHEET_FIELDS.picture.column,
          value: aiColumns.photoFileId,
        },
      );
    }

    /*
     * ⚠⚠ **STONE の表 (`order_sheet_line_stones`) には触らない。**
     *   ⚠ セル `"G16"` は、下部のメモがあれば**空のときだけ**上の
     *   `fillFromSpecNote()` が入れる。人の値は上書きしない。
     *
     *   AI の読み取りから石を外したので、この欄の出どころは**人の入力だけ**になった
     *   (セルへ移したので、いまは `cells_json` の `"G:0"`)。
     *   以前はここで明細ごとに `order_sheet_line_stones` を**無条件に全消し**してから
     *   入れ直していた (「石は人が触る欄ではない」前提)。**その delete を残すと、
     *   読み取りをやり直すたびに人が入れた STONE が消える。**
     *   `photoFileId` の「1 行も無いときは null で上書きしない」と同じ考え方で、
     *   AI 由来の値が無いなら**行に一切触れない**のが正しい。
     */
  }

  // 読み取りをやり直して明細が減ったときに、古い行を残さない。
  await db
    .delete(orderSheetLines)
    .where(
      and(
        eq(orderSheetLines.orderSheetId, orderSheetId),
        gt(orderSheetLines.lineNo, poLines.length),
      ),
    );

  return {
    orderSheetId,
    lineCount: poLines.length,
    fields,
    rawOutput: JSON.stringify({
      caseId: input.caseId,
      orderSheetId,
      purchaseOrderIds: orders.map((row) => row.id),
      revisionRequestIds: revisions.map((row) => row.id),
      matches,
    }),
  };
}

/** 切り出せた絵 1 枚 (依頼書の鍵から開いたもの)。 */
interface LinePhotoCandidate {
  fileId: string;
  sha256: string;
  /** その依頼書の何枚目か (鍵の接尾辞)。 */
  pictureIndex: number;
}

/**
 * ★★ その明細の代表の図を**どう更新するか**を決める (書き込みはしない)。
 *
 * ⚠⚠ **人が外した絵を読み直しで戻さないことが最優先。** 外したことを持っているのは
 *   `order_sheet_line_photos.deleted_at` だけなので、**消した行も含めて**引いて墓標にする。
 * ⚠⚠ **墓標は `file_id` の一致 OR `files.sha256` の一致の 2 本。** 「読み取りをやり直す」と
 *   `revision_requests` ごと作り直されて鍵も `file_id` も変わるため、ID だけでは戻ってくる。
 *   同じ枠を同じ dpi で切れば同じバイト列になるので sha256 で捕まえる。
 *   ⚠ 保証はここまで —「**同じ絵は戻ってこない**」であって「似た絵は戻らない」ではない。
 * ⚠ **既にある行は触らない** (`sort_key` を保つ)。**生きている行は消さない**
 *   (＝「null で上書きしない」の複数枚版)。
 */
async function planLinePhotos(
  db: Db,
  input: {
    lineId: string;
    /** 今回はじめて作る明細か (それなら引くまでもなく 0 行)。 */
    isNewLine: boolean;
    revisionRequestId: string | null;
    candidates: LinePhotoCandidate[];
    now: Date;
  },
): Promise<{
  /** これから入れる行 (明細を書いたあとで入れる)。 */
  inserts: {
    id: string;
    orderSheetLineId: string;
    fileId: string;
    revisionRequestId: string | null;
    sortKey: number;
    createdAt: Date;
  }[];
  /** 生きている先頭 = Picture 欄の代表。1 枚も残らなければ null。 */
  representative: string | null;
  /** 写真の行が 1 つでもあるか (消した行も数える)。 */
  hasRows: boolean;
  /** 今回はじめて入る絵。欄の記録を積むかどうかの判断に使う。 */
  freshFileIds: Set<string>;
}> {
  const existing = input.isNewLine
    ? []
    : await db
        .select({
          fileId: orderSheetLinePhotos.fileId,
          sortKey: orderSheetLinePhotos.sortKey,
          deletedAt: orderSheetLinePhotos.deletedAt,
          sha256: files.sha256,
        })
        .from(orderSheetLinePhotos)
        .leftJoin(files, eq(files.id, orderSheetLinePhotos.fileId))
        .where(eq(orderSheetLinePhotos.orderSheetLineId, input.lineId))
        .orderBy(asc(orderSheetLinePhotos.sortKey));

  const retired = existing.filter((row) => row.deletedAt !== null);
  const retiredFileIds = new Set(retired.map((row) => row.fileId));
  const retiredShas = new Set(
    retired.map((row) => row.sha256).filter((sha): sha is string => sha !== null),
  );
  const known = new Set(existing.map((row) => row.fileId));
  /**
   * ⚠⚠ **生きている行の sha256 も見る。** 「読み取りをやり直す」と `revision_requests` ごと
   *   作り直されて `file_id` が変わるので、`file_id` だけで見ていると**同じ絵が 2 行目として
   *   差し込まれる** (明細の行は `(order_sheet_id, line_no)` で引き直されるので残る)。
   *   墓標 (`retiredShas`) と対で、こちらは「**読み直しても枚数が増えない**」ほうを受け持つ。
   * ⚠ 差し込むそばからここに足す (同じ実行の中でも、同じバイト列を 2 行にしない)。
   */
  const livingShas = new Set(
    existing
      .filter((row) => row.deletedAt === null)
      .map((row) => row.sha256)
      .filter((sha): sha is string => sha !== null),
  );
  let nextSortKey = existing.reduce((max, row) => Math.max(max, row.sortKey + 1), 0);

  const inserts = [];
  for (const candidate of input.candidates) {
    // 既にこの明細に付いている絵 (生きているものも外したものも) は触らない。
    if (known.has(candidate.fileId)) continue;
    // ⚠⚠ 人が外した絵は差し込まない (ID が変わっていても同じバイト列なら止める)。
    if (retiredFileIds.has(candidate.fileId) || retiredShas.has(candidate.sha256)) continue;
    // ⚠⚠ 同じバイト列の絵は 1 行だけ (読み直しで枚数が増えない)。
    if (livingShas.has(candidate.sha256)) continue;
    livingShas.add(candidate.sha256);
    inserts.push({
      id: uuidv7(),
      orderSheetLineId: input.lineId,
      fileId: candidate.fileId,
      revisionRequestId: input.revisionRequestId,
      sortKey: nextSortKey++,
      createdAt: input.now,
    });
  }

  const living = [
    ...existing.filter((row) => row.deletedAt === null).map((row) => row.fileId),
    ...inserts.map((row) => row.fileId),
  ];

  return {
    inserts,
    representative: living[0] ?? null,
    hasRows: existing.length + inserts.length > 0,
    freshFileIds: new Set(inserts.map((row) => row.fileId)),
  };
}

/**
 * ★★ 依頼書の**下部のメモ** を明細のセルに重ねる。**将来は消す機能。**
 *
 * ⚠⚠ **消すときはこの関数と、呼んでいる 1 行と、Size の来歴の分岐を消す。**
 *   ほかの消す場所は ai の `contract.ts` の `specNoteFields` の注記。
 * ⚠⚠ **人が入れる欄 (STONE `G16` / POLISH `F17` / メッキ `F18` / ロゴ `F20`) は、
 *   セルが空のときだけ入れる。** 読み直しで人の入力を上書きしない
 *   (Picture の「null で上書きしない」と同じ考え方)。⚠ `F19` は空のまま。
 * ⚠ **欄の記録は積まない。** どれも `by: "human"` の欄なので、積むと
 *   正答率の分母 (AI の欄) が水増しされる。原本へ戻る記録は `spec-writer.ts` が
 *   `revision_request_specs.note_*` に積んである。
 * ⚠ `order_sheet_line_stones` など孤児の表は使わない。
 * ⚠ **Size は発注書が空のときだけ** (`H16` は AI のセルで、上で発注書の値を書き終えている)。
 *   通すのは発注書と同じ `formatSizeText()`。
 *
 * @returns メモから入れた Size (入れなければ null)。来歴の引き継ぎ元を決めるのに使う。
 */
function fillFromSpecNote(
  cells: Record<string, string>,
  lineIndex: number,
  revision:
    | {
        noteSizeText: string | null;
        noteStoneText: string | null;
        noteDescription2: string | null;
        noteDescription3: string | null;
        noteDescription4: string | null;
      }
    | undefined,
): string | null {
  if (!revision) return null;

  const humanCells: [ref: string, value: string | null][] = [
    [lineCellRef("G", lineIndex, 0), revision.noteStoneText],
    [lineCellRef("F", lineIndex, 1), revision.noteDescription2],
    [lineCellRef("F", lineIndex, 2), revision.noteDescription3],
    [lineCellRef("F", lineIndex, 4), revision.noteDescription4],
  ];
  for (const [ref, value] of humanCells) {
    const text = normalizeNoteText(value);
    if (text.length > 0 && !(ref in cells)) cells[ref] = text;
  }

  const sizeRef = targetColumnOf("size", lineIndex);
  if (sizeRef in cells) return null;
  const size = formatSizeText(revision.noteSizeText);
  if (size !== null) cells[sizeRef] = size;
  return size;
}

/**
 * 温度の単位の**1 文字の記号**を、紙の印字の形 (`°` + 英字) に寄せる。
 *
 * ⚠ 実測 で、紙の `°C` が `℃` (U+2103) で返った回があった。印字そのままの
 *   比較では別の値になるので、読み取りでは直さず (ai の quote は返ったままを残す)、
 *   **セルに入れるときだけ**寄せる。
 */
const NOTE_TEXT_REPLACEMENTS: readonly [from: string, to: string][] = [
  ["\u2103", "\u00B0C"],
  ["\u2109", "\u00B0F"],
];

/**
 * ★ 下部のメモの値を、セルに入れる形にする (前後の空白を落とし、温度の記号を寄せる)。
 *
 * ⚠⚠ **`normalize("NFKC")` を使わない。** タイ文字を壊す (`ำ` が 2 文字に分解される)。
 *   帳票には日本語・タイ語・英数字が 1 つの語の中で混ざる。半角カナなども
 *   **紙がそうならそのまま**にする (寄せるのは上の表の記号だけ)。
 */
export function normalizeNoteText(value: string | null | undefined): string {
  let text = value?.trim() ?? "";
  for (const [from, to] of NOTE_TEXT_REPLACEMENTS) text = text.replaceAll(from, to);
  return text;
}

/**
 * ★ Description の 2 行目 (値が入る行) を作る。
 *
 * **出どころは依頼書だけ。**「表題のすぐ下で選ばれている区分」から引いた語と、
 * 同じ依頼書の**品位**を空白でつなぐ (実物は `CASTING SV950`)。
 *
 * ⚠⚠ **発注書の資材名へは落とさない。** 以前は区分が読めないときに資材名をそのまま
 *   入れていたが、資材名は細かい印字で**読み違えが起きる**（実測で、紙に無い
 *   `SV950 部品X` が入った）。**空のほうが正しい**。
 *   資材名は STONE の形の符号 (`DIA RD`) を引くのにだけ使う。
 * ⚠ 区分が一覧 (`description-text.ts` の閉じた集合) に無ければ**語を出さない** → 欄は空。
 * ⚠ ここに来る `requestCategoryText` は **既に選ばれた 1 語**
 *   (`spec-writer.ts` が `chooseRequestCategory()` で決めて `remark` に入れてある)。
 * ⚠ **転記元を必ず 1 つ以上数える。** ここを漏らすと Description だけ塗り分けも正答率も出ない。
 * ⚠ 3 行目以降 (POLISH・メッキ・ロゴ) は対応不要。人が画面のセルに打ち込む。
 */
function buildDescription(
  revision:
    | { specId: string | null; purityText: string | null; requestCategoryText: string | null }
    | undefined,
): { text: string | null; sources: { table: string; rowId: string; column: string }[] } {
  const prefix = descriptionPrefix(revision?.requestCategoryText ?? null);
  if (!revision?.specId || !prefix) return { text: null, sources: [] };

  const purity = revision.purityText?.trim() ?? "";
  return {
    text: purity.length > 0 ? `${prefix} ${purity}` : prefix,
    sources: [
      { table: "revision_request_specs", rowId: revision.specId, column: "remark" },
      ...(purity.length > 0
        ? [{ table: "revision_request_specs", rowId: revision.specId, column: "purity_text" }]
        : []),
    ],
  };
}

type SourceRecord = Awaited<ReturnType<typeof findFieldRecord>>;

/** 転記元の欄の記録を引く。無ければ null (= AI が読んだ欄ではない)。 */
async function sourceOf(
  env: Bindings,
  table: string,
  rowId: string,
  column: string,
): Promise<SourceRecord> {
  return findFieldRecord(env, { table, rowId, column });
}

/** 合成した欄の確信度は、**寄与したうちで一番低いもの**に合わせる。 */
async function weakestOf(
  env: Bindings,
  extra: { table: string; rowId: string; column: string }[],
): Promise<SourceRecord> {
  let weakest: SourceRecord = null;
  for (const target of extra) {
    const record = await findFieldRecord(env, target);
    if (record && (!weakest || record.confidence < weakest.confidence)) weakest = record;
  }
  return weakest;
}

/**
 * 転記した欄を 1 行として積む。
 *
 * ⚠ **転記元に記録が無い欄は積まない。** 積むと「AI が埋めた欄」に数えられ、
 *   正答率の分母が水増しされる (数えるのは AI が埋めた欄だけ)。
 * ⚠ **値が空の欄も積まない。** 同じ理由。
 */
function pushInherited(
  fields: FieldRecord[],
  source: SourceRecord,
  target: { table: string; rowId: string; column: string; value: string | number | null },
): void {
  if (!source) return;
  if (target.value === null || target.value === "") return;

  fields.push({
    targetTable: target.table,
    targetRowId: target.rowId,
    targetColumn: target.column,
    // 原本の印字はそのまま引き継ぐ (どこから来たかを辿れるように)。
    rawValue: source.rawValue,
    normalizedValue: String(target.value),
    // ⚠ 転記で新しい確信度は生まれない。読み取ったときの値をそのまま持ち越す。
    confidence: source.confidence,
    pageNo: source.pageNo,
  });
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
