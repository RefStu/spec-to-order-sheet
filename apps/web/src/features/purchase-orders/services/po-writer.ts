import { type FieldRecord, toFieldRecord } from "../../ai-review/lib/extraction-fields";
import type { ExtractedPurchaseOrder } from "../../ai-review/lib/ai-contract";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import type { Db, DbStatement } from "../../../shared/db";
import { asInteger, asText } from "../lib/coerce";
import { purchaseOrderLines, purchaseOrders } from "../db/schema";

/** 数量が読めなかったときに入れる値。**読めたふりをしない**ので確信度は 0 にする。 */
const UNKNOWN_QUANTITY = 0;
/** 単位が読めなかったときに入れる値。`order_sheet_lines.unit_code` も NOT NULL。 */
const DEFAULT_UNIT = "PCS";

export interface PoWriteBuild {
  /** ⚠ **まだ実行していない文。** 呼んだ側が 1 つの batch にまとめて流す。 */
  statements: DbStatement[];
  purchaseOrderId: string;
  /** 欄ごとの記録。**欄 1 つ = 1 行。** */
  fields: FieldRecord[];
  /**
   * 明細番号 (PDF の中の `lineNo`) -> いま採番した `purchase_order_lines.id`。
   *
   * ⚠ ai の対応づけ (`links`) が持つのは**この PDF の中の添字**だけなので、
   *   同じ batch を組んでいるうちに D1 の ID へ開けるようにする
   *   (`revision_requests.purchase_order_line_id`)。あとからでは復元できない。
   */
  lineIdByLineNo: Map<number, string>;
}

/**
 * 読み取った発注書を書く文を組み立てる。
 *
 * ⚠⚠ **ここでは実行しない。** 実行は `document-writer.ts` が
 *   「前の版を取り下げる → 書く」を **1 つの batch (= トランザクション)** で行う。
 *   分けてあるのは、retry と「読み取りをやり直す」を**冪等**にするため。
 * ⚠ **UUIDv7 を先に採番してから INSERT する。** `ai_extraction_fields.target_row_id` が
 *   「どの行に書いたか」を指すので、行 ID が先に決まっていないと欄の記録が作れない。
 * ⚠ お客様が書いた文字列 (`raw_*`) と解決した値の**両方**を持つ。
 *   解決できなくても**行は作る** (空のまま先へ進める)。
 * ⚠ **取引先の解決 (`resolvePartner`) はここでやらない。** 読んで、無ければ作る操作なので
 *   batch に入れられない。呼ぶ側が先に解決して `partnerId` を渡す。
 */
export function buildPurchaseOrderWrite(
  db: Db,
  input: {
    poDocumentId: string;
    caseId: string;
    partnerId: string;
    extraction: ExtractedPurchaseOrder;
    now: Date;
  },
): PoWriteBuild {
  const { header, lines } = input.extraction;
  const statements: DbStatement[] = [];
  const fields: FieldRecord[] = [];
  const now = input.now;

  const purchaseOrderId = uuidv7();
  // ⚠ `customer_po_no` は NOT NULL。読めなければ空文字を入れて先へ進める
  //   (空にできないと 1 行も書けずに止まる)。
  const customerPoNo = asText(header.customerPoNo) ?? "";

  statements.push(
    db.insert(purchaseOrders).values({
      id: purchaseOrderId,
      poDocumentId: input.poDocumentId,
      caseId: input.caseId,
      partnerId: input.partnerId,
      customerPoNo,
      // ⚠ `ordered_on` は入れない (ai が発注日を読まなくなった。列だけ残してある)。
      status: "parsed",
      // プロンプトを変えて読み直したときに比べられるよう、生の構造も残す。
      rawJson: JSON.stringify(input.extraction),
      createdAt: now,
      updatedAt: now,
    }),
  );

  // ⚠ `purchase_orders.partner_id` の記録は積まない。取引先名を読み取らないので、
  //   ORDER SHEET の CUSTOMER は空のまま (`order-sheet-fields.ts` の注記)。
  pushField(fields, header.customerPoNo, {
    table: "purchase_orders",
    rowId: purchaseOrderId,
    column: "customer_po_no",
  });
  const lineIdByLineNo = new Map<number, string>();
  for (const line of lines) {
    const lineId = uuidv7();
    lineIdByLineNo.set(line.lineNo, lineId);
    const quantity = asInteger(line.quantity);

    statements.push(
      db.insert(purchaseOrderLines).values({
        id: lineId,
        purchaseOrderId,
        lineNo: line.lineNo,
        // お客様が書いた文字列をそのまま持つ (解決できなくても行は作る)。
        rawModelNo: asText(line.modelNo),
        // ⚠ 資材名。Code master は製造番号か仕様書No から取るので、品番は読まない。
        rawProductName: asText(line.productName),
        rawSizeText: asText(line.sizeText),
        sizeText: asText(line.sizeText),
        // ⚠ quantity / unit_code は NOT NULL。読めなかった行も作れるように既定値を入れ、
        //   人の確認に回す (空にできないと 1 行も書けずに止まる)。
        quantity: quantity ?? UNKNOWN_QUANTITY,
        // ⚠ 単位は**読み取りではなく固定値**。モデルに読ませていない。
        unitCode: DEFAULT_UNIT,
        // ⚠⚠ **requested_ship_date は書かない。** 出どころが確定できないので読み取りを
        //   やめた (人が ORDER SHEET の SHIP DATE に入れる)。**列は残す。**
        remark: asText(line.remarkText),
        reviewStatus: quantity === null ? "needs_review" : "auto",
        sourcePageNo: line.quantity.page ?? line.modelNo.page,
        createdAt: now,
        updatedAt: now,
      }),
    );

    fields.push(...lineFields(line, lineId));
  }

  return { statements, purchaseOrderId, fields, lineIdByLineNo };
}

function pushField(
  fields: FieldRecord[],
  field: Parameters<typeof toFieldRecord>[0],
  target: Parameters<typeof toFieldRecord>[1],
): void {
  const record = toFieldRecord(field, target);
  if (record) fields.push(record);
}

function lineFields(line: ExtractedPurchaseOrder["lines"][number], lineId: string): FieldRecord[] {
  const target = (column: string) => ({ table: "purchase_order_lines", rowId: lineId, column });
  const records: FieldRecord[] = [];
  pushField(records, line.modelNo, target("raw_model_no"));
  pushField(records, line.productName, target("raw_product_name"));
  pushField(records, line.sizeText, target("raw_size_text"));
  pushField(records, line.quantity, target("quantity"));
  pushField(records, line.remarkText, target("remark"));
  return records;
}

export { DEFAULT_UNIT, UNKNOWN_QUANTITY };
