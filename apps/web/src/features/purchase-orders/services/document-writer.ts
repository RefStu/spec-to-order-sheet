import { and, eq, isNull } from "drizzle-orm";
import type { DocExtractResult } from "../../ai-review/lib/ai-contract";
import type { FieldRecord } from "../../ai-review/lib/extraction-fields";
import { revisionRequests } from "../../revisions/db/schema";
import { buildRevisionRequestWrites } from "../../revisions/services/spec-writer";
import { createDb, type DbStatement, runBatch } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { poDocuments, purchaseOrders } from "../db/schema";
import { buildPurchaseOrderWrite } from "./po-writer";
import { resolvePartner } from "./partner-resolver";

export type DocumentKind = "purchase_order" | "spec_sheet" | "mixed" | "unknown";

export interface DocumentWriteResult {
  purchaseOrderId: string | null;
  partnerId: string | null;
  partnerName: string | null;
  partnerCreated: boolean;
  revisionRequestIds: string[];
  /** 案件の見出しに返す仕様書No (最初に読めたもの)。 */
  specNo: string | null;
  /** 読んだ結果ぶんの種類。**登録のときは unknown で、ここで初めて確定する。** */
  docKind: DocumentKind;
  /** 欄ごとの記録。**欄 1 つ = 1 行。** */
  fields: FieldRecord[];
}

/** 読めたものから帳票の種類を決める。**判定していないものを名乗らせない。** */
function docKindOf(extraction: DocExtractResult["extraction"]): DocumentKind {
  const hasPo = extraction.purchaseOrder !== null;
  const hasSpec = extraction.specSheets.length > 0;
  if (hasPo && hasSpec) return "mixed";
  if (hasPo) return "purchase_order";
  if (hasSpec) return "spec_sheet";
  return "unknown";
}

/**
 * ★★ 読み取った帳票 1 通ぶんを D1 に書く。**ここが冪等の要。**
 *
 * ⚠⚠ **「前の版を取り下げる → 書く → 原本を更新する」を 1 つの batch で行う。**
 *   D1 の batch は 1 往復のトランザクションなので、途中で割れない。
 *   - retry (キューの再配達) も「読み取りをやり直す」も、**同じ batch をもう一度流すだけ**
 *     になる。
 *   - 取り下げで鍵が解放されるのは **部分索引 (migration 0003) が入っているから**。
 *     素の UNIQUE のままだと、論理削除した行が鍵を握って入れ直せない。
 * ⚠ **取り下げは `po_document_id` を鍵にする。** 「この帳票から作った行」を丸ごと入れ替える。
 *   欄の記録 (`ai_extraction_fields`) も版で入れ替わるので、混ざらない。
 * ⚠ **取引先の解決は batch の外。** 読んで、無ければ作る操作なので batch に入れられない。
 * ⚠ 呼ぶ側 (consumer) は、**このあと** `updateCase()` と `recordExtraction()` を走らせる。
 */
export async function writeExtractedDocument(
  env: Bindings,
  input: {
    poDocumentId: string;
    caseId: string;
    aiJobId: string;
    extraction: DocExtractResult["extraction"];
  },
): Promise<DocumentWriteResult> {
  const db = createDb(env);
  const now = new Date();
  const { purchaseOrder, specSheets } = input.extraction;
  const docKind = docKindOf(input.extraction);

  // ── 取引先 (batch の外) ───────────────────────────────────────────────────
  // ⚠⚠ **取引先名は読み取らない。** 実物の発注書には差出人・納入場所・受付窓口が別々に
  //   印字されていて、どれが ORDER SHEET の CUSTOMER になるかが決まっていない。
  //   **別の会社名を自信たっぷりに入れるのが一番悪い**ので、器だけ用意して空にしておく。
  // ⚠ 同じ原本に既に取引先が付いていればそれを使う (人が直したものを消さない)。
  //   `revision_requests.partner_id` / `purchase_orders.partner_id` は NOT NULL。
  let partner: { partnerId: string; name: string; created: boolean } | null = null;
  if (purchaseOrder || specSheets.length > 0) {
    const [document] = await db
      .select({ partnerId: poDocuments.partnerId })
      .from(poDocuments)
      .where(eq(poDocuments.id, input.poDocumentId))
      .limit(1);
    partner = document?.partnerId
      ? { partnerId: document.partnerId, name: "", created: false }
      : await resolvePartner(env, null);
  }

  const statements: DbStatement[] = [];

  // ── ① 前の版を取り下げる ─────────────────────────────────────────────────
  // ⚠ **必ず先頭に置く。** batch は順に流れるので、取り下げてから書けば
  //   同じ鍵の行が 2 つ生きている瞬間が無い。
  statements.push(
    db
      .update(purchaseOrders)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(eq(purchaseOrders.poDocumentId, input.poDocumentId), isNull(purchaseOrders.deletedAt)),
      ),
    db
      .update(revisionRequests)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(revisionRequests.sourcePoDocumentId, input.poDocumentId),
          isNull(revisionRequests.deletedAt),
        ),
      ),
  );

  // ── ② 書く ───────────────────────────────────────────────────────────────
  const fields: FieldRecord[] = [];
  let purchaseOrderId: string | null = null;
  let poLineIdByLineNo: ReadonlyMap<number, string> | undefined;
  if (purchaseOrder && partner) {
    const built = buildPurchaseOrderWrite(db, {
      poDocumentId: input.poDocumentId,
      caseId: input.caseId,
      partnerId: partner.partnerId,
      extraction: purchaseOrder,
      now,
    });
    statements.push(...built.statements);
    fields.push(...built.fields);
    purchaseOrderId = built.purchaseOrderId;
    /*
     * ⚠⚠ **発注書を先に組むから、明細の ID がもう決まっている。** 依頼書側は
     *   これを使って ai の対応づけ (PDF の中の添字) を D1 の ID へ開く。
     *   ⚠ 順番を入れ替えないこと (入れ替えると開けなくなる)。
     */
    poLineIdByLineNo = built.lineIdByLineNo;
  }

  let revisionRequestIds: string[] = [];
  let specNo: string | null = null;
  if (specSheets.length > 0 && partner) {
    const built = buildRevisionRequestWrites(db, {
      poDocumentId: input.poDocumentId,
      caseId: input.caseId,
      aiJobId: input.aiJobId,
      partnerId: partner.partnerId,
      extractions: specSheets,
      // ⚠ 依頼書と発注書明細の**対応づけ**に要る (`aiLinkedLineIdOf`)。石とは無関係。
      purchaseOrder,
      // ★ ai の対応づけ。**添字はこの PDF の中でしか意味を持たない**ので、ここで使い切る。
      links: input.extraction.links,
      // ★ 添字を D1 の ID へ開くための表 (発注書が無ければ undefined)。
      purchaseOrderLineIdByLineNo: poLineIdByLineNo,
      now,
    });
    statements.push(...built.statements);
    fields.push(...built.fields);
    revisionRequestIds = built.revisionRequestIds;
    specNo = built.specNos.find((value) => value !== null) ?? null;
  }

  // ── ③ 原本の状態を更新する (最後) ───────────────────────────────────────
  statements.push(
    db
      .update(poDocuments)
      .set({
        ...(partner ? { partnerId: partner.partnerId } : {}),
        /*
         * ⚠⚠ **`form_profile_id` はもう書かない。** 様式の候補を ai に渡すのをやめたので、
         *   分類が返す code と `partner_form_profiles` の行を突き合わせる相手が居ない。
         *   **列は残す** — 様式の判定が入るまで NULL のまま。
         */
        docKind,
        status: "parsed",
      })
      .where(eq(poDocuments.id, input.poDocumentId)),
  );

  await runBatch(db, statements);

  return {
    purchaseOrderId,
    partnerId: partner?.partnerId ?? null,
    partnerName: partner?.name || null,
    partnerCreated: partner?.created ?? false,
    revisionRequestIds,
    specNo,
    docKind,
    fields,
  };
}
