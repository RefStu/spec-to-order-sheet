import type {
  ExtractedPurchaseOrder,
  ExtractedSpecNote,
  ExtractedSpecSheet,
} from "../../ai-review/lib/ai-contract";
import { type FieldRecord, toFieldRecord } from "../../ai-review/lib/extraction-fields";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import { chooseRequestCategory } from "../../order-sheets/lib/description-text";
import { applyAiLinks, matchBySpecNo, type AiLink } from "../../order-sheets/lib/spec-no";
import { asText } from "../../purchase-orders/lib/coerce";
import type { Db, DbStatement } from "../../../shared/db";
import { revisionRequestSpecs, revisionRequests } from "../db/schema";

export interface SpecWriteBuild {
  /** ⚠ **まだ実行していない文。** 呼んだ側が 1 つの batch にまとめて流す。 */
  statements: DbStatement[];
  revisionRequestIds: string[];
  /** 案件の見出しに返す最初の仕様書No。 */
  specNos: (string | null)[];
  fields: FieldRecord[];
}

/**
 * 読み取った依頼書を書く文を組み立てる。
 *
 * ⚠⚠ **依頼書は 1 通の PDF に明細の数だけ入る。** だから入力は**配列**。
 *   1 枚 = `revision_requests` 1 行。
 * ⚠ **ここでは実行しない。** 実行は `document-writer.ts` が 1 batch でまとめて行う
 *   (retry と「読み取りをやり直す」を冪等にするため)。
 * ⚠ **依頼書は「AI が作るもの」ではなく「AI が読むもの」。** お客様から届く書類なので、
 *   `generated_by` は「AI が読み取って起こした行か」の意味で `ai` を入れる
 *   (AI が依頼を起こしたという意味ではない)。
 * ⚠ 取り出すのは **ORDER SHEET に出る項目だけ**。完成重量や希望原価は読まない。
 * ⚠ **`partnerId` は呼ぶ側が解決して渡す**(`revision_requests.partner_id` は NOT NULL。
 *   依頼書に取引先名が印字されていないことがある)。
 * ⚠⚠ **石は読まない。** AI の読み取りから外したので `revision_request_stones`
 *   に行を作る経路はここには無い。**表は残っているが書き手が居ない。**
 *   ORDER SHEET の STONE 欄は人が入れる (紙の G 列のセル = `cells_json` の `"G16"` など)。
 */
export function buildRevisionRequestWrites(
  db: Db,
  input: {
    poDocumentId: string;
    caseId: string;
    aiJobId: string;
    partnerId: string;
    extractions: readonly ExtractedSpecSheet[];
    /** 同じ PDF に入っていた発注書 (明細との対応づけに使う)。 */
    purchaseOrder?: ExtractedPurchaseOrder | null;
    /**
     * ai の最終ノードが返した対応づけ。**規則で結べなかったぶんの埋め草**にだけ使う。
     * ⚠ 添字は**この PDF の中**でしか意味を持たない (だから同じ読み取りのうちに使い切る)。
     */
    links?: readonly AiLink[];
    /**
     * 明細番号 -> `purchase_order_lines.id` (`buildPurchaseOrderWrite` が採番したもの)。
     * ⚠ **同じ batch を組んでいるうちにしか開けない。** ai の対応づけが持つのは
     *   PDF の中の添字だけで、ORDER SHEET の組み立ては別ジョブで D1 の UUID から始まる。
     */
    purchaseOrderLineIdByLineNo?: ReadonlyMap<number, string>;
    now: Date;
  },
): SpecWriteBuild {
  const statements: DbStatement[] = [];
  const fields: FieldRecord[] = [];
  const revisionRequestIds: string[] = [];
  const specNos: (string | null)[] = [];
  const now = input.now;
  const { aiLinkedLineIdOf } = linkSheets(
    input.extractions,
    input.purchaseOrder ?? null,
    input.links ?? [],
    input.purchaseOrderLineIdByLineNo ?? null,
  );

  for (const [sheetIndex, extraction] of input.extractions.entries()) {
    const { specNo, productName, purityText, requestCategoryText } = extraction;
    // ★★ 区分は「**その語に丸が囲われているか**」で決まる (実物で確認した)。
    //   ai が語ごとに marked を返すので、印が 1 つに絞れたときだけその語を採る。
    // ⚠ 絞れなければ null = Description は空のまま (でっち上げない)。
    const requestCategory = chooseRequestCategory(asText(requestCategoryText));
    const revisionRequestId = uuidv7();
    revisionRequestIds.push(revisionRequestId);
    specNos.push(asText(specNo));

    statements.push(
      db.insert(revisionRequests).values({
        id: revisionRequestId,
        specNo: asText(specNo),
        version: 1,
        partnerId: input.partnerId,
        caseId: input.caseId,
        sourcePoDocumentId: input.poDocumentId,
        /*
         * ⚠ **規則で結べなかった明細に ai が当てたぶんだけ**が入る (null が既定)。
         *   規則 (`matchBySpecNo`) で結べるものは ORDER SHEET 側でも同じ結論になるので、
         *   ここに書き写さない (正が 2 か所になる)。
         */
        purchaseOrderLineId: aiLinkedLineIdOf(sheetIndex),
        // ⚠ 製造番号が印字されていない明細と結ぶための予備の鍵。
        productionName: asText(productName),
        requestType: "new_spec",
        // parsed = 原紙を読み取って行を作った。
        status: "parsed",
        generatedBy: "ai",
        sourceAiJobId: input.aiJobId,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const specId = uuidv7();
    statements.push(
      db.insert(revisionRequestSpecs).values({
        id: specId,
        revisionRequestId,
        // ⚠ 品位はマスタ (materials) に引き当てず、印字そのままを持つ。
        //   PoC はマスタが空で、引けないと行が作れなくなるため。
        purityText: asText(purityText),
        // ⚠ 表題の下の区分 (「鋳造」など) の**選ばれた 1 語**。
        //   Description の頭に付く語を決めるのに使う (語の対応は order-sheets 側)。
        // ⚠⚠ **読み取りの記録 (下の pushField) は印字そのままのまま。**
        //   記録は原本に戻るためのもの、こちらは転記に使う値、と役割を分ける。
        remark: requestCategory,
        // ★ 下部のメモ (**将来は消す**)。印字そのまま。無ければ null。
        ...specNoteColumns(extraction.specNote),
      }),
    );

    pushField(fields, specNo, {
      table: "revision_requests",
      rowId: revisionRequestId,
      column: "spec_no",
    });
    pushField(fields, productName, {
      table: "revision_requests",
      rowId: revisionRequestId,
      column: "production_name",
    });
    pushField(fields, purityText, {
      table: "revision_request_specs",
      rowId: specId,
      column: "purity_text",
    });
    pushField(fields, requestCategoryText, {
      table: "revision_request_specs",
      rowId: specId,
      column: "remark",
    });
    // ⚠ メモの欄の記録も残す (原本へ戻る手がかり・確信度の引き継ぎ元)。
    if (extraction.specNote) {
      for (const [key, column] of SPEC_NOTE_COLUMNS) {
        pushField(fields, extraction.specNote[key], {
          table: "revision_request_specs",
          rowId: specId,
          column,
        });
      }
    }
  }

  return { statements, revisionRequestIds, specNos, fields };
}

/**
 * 依頼書 1 枚ごとに、突き合わせた**発注書明細**の情報を返す。
 *
 * - `aiLinkedLineIdOf` … **規則で結べず、ai の対応づけで埋めたぶんだけ**の
 *   `purchase_order_lines.id`。`revision_requests.purchase_order_line_id` に入れる。
 *
 * ⚠⚠ **石をやめても、この関数は消さないこと。** 以前はここが「資材名」(石の形の符号の
 *   出どころ) も返していたので石専用に見えるが、いま残っている `aiLinkedLineIdOf` は
 *   **石と無関係**で、発注書明細との対応づけそのものを担っている。
 * ⚠ 突き合わせの規則は `order-sheets/lib/spec-no.ts` の 1 か所だけ。ここでは呼ぶだけ。
 * ⚠ 発注書が同じ PDF に入っていない (依頼書だけ届いた) ときは null。
 */
function linkSheets(
  extractions: readonly ExtractedSpecSheet[],
  purchaseOrder: ExtractedPurchaseOrder | null,
  links: readonly AiLink[],
  lineIdByLineNo: ReadonlyMap<number, string> | null,
): {
  aiLinkedLineIdOf: (sheetIndex: number) => string | null;
} {
  if (!purchaseOrder) return { aiLinkedLineIdOf: () => null };

  const byRule = matchBySpecNo({
    lines: purchaseOrder.lines.map((line) => ({
      lineId: String(line.lineNo),
      rawModelNo: asText(line.modelNo),
      rawProductName: asText(line.productName),
    })),
    revisions: extractions.map((sheet, index) => ({
      revisionRequestId: String(index),
      specNo: asText(sheet.specNo),
      productName: asText(sheet.productName),
    })),
  });
  /*
   * ⚠ **規則で結べなかった明細にだけ** ai の対応づけを当てる (`applyAiLinks`)。
   *   ここは添字どうしで閉じているので、そのまま当てられる
   *   (`lineId` = 明細番号の文字列 / `revisionRequestId` = 依頼書の添字の文字列)。
   */
  const { matches } = applyAiLinks(
    byRule,
    links,
    (lineNo) => (purchaseOrder.lines.some((row) => row.lineNo === lineNo) ? String(lineNo) : null),
    (index) => (index < extractions.length ? String(index) : null),
  );

  /*
   * ⚠⚠ **`matchedBy === "model"` のものだけを残す。** 規則で結べたものは ORDER SHEET を
   *   組むときに同じ規則で結び直せるので、ここに書き写すと正が 2 か所になる。
   * ⚠ 発注書の明細の ID が渡されていない経路 (同じ batch を組んでいない) では入れない。
   */
  const lineIdBySheetIndex = new Map<string, string>();
  if (lineIdByLineNo) {
    for (const match of matches) {
      if (match.matchedBy !== "model" || match.revisionRequestId === null) continue;
      const lineId = lineIdByLineNo.get(Number(match.lineId));
      if (lineId !== undefined) lineIdBySheetIndex.set(match.revisionRequestId, lineId);
    }
  }

  return {
    aiLinkedLineIdOf: (sheetIndex) => lineIdBySheetIndex.get(String(sheetIndex)) ?? null,
  };
}

/**
 * ★ 下部のメモの欄 -> `revision_request_specs` の列名。**将来は消す。**
 * ⚠ 列名は `revisions/db/schema.ts` の `note_*` と同じ文字列 (欄の記録の `column` に入る)。
 */
const SPEC_NOTE_COLUMNS = [
  ["sizeText", "note_size_text"],
  ["stoneText", "note_stone_text"],
  ["description2", "note_description2"],
  ["description3", "note_description3"],
  ["description4", "note_description4"],
] as const satisfies readonly (readonly [keyof ExtractedSpecNote, string])[];

/** メモを列の値にする。⚠ ノードが走っていない (null) ときは全部 null。 */
function specNoteColumns(note: ExtractedSpecNote | null) {
  return {
    noteSizeText: note ? asText(note.sizeText) : null,
    noteStoneText: note ? asText(note.stoneText) : null,
    noteDescription2: note ? asText(note.description2) : null,
    noteDescription3: note ? asText(note.description3) : null,
    noteDescription4: note ? asText(note.description4) : null,
  };
}

function pushField(
  fields: FieldRecord[],
  field: Parameters<typeof toFieldRecord>[0],
  target: Parameters<typeof toFieldRecord>[1],
): void {
  const record = toFieldRecord(field, target);
  if (record) fields.push(record);
}
