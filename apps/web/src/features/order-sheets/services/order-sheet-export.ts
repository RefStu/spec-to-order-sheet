import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { files } from "../../files/db/schema";
import { readBytes } from "../../files/services/upload-service";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import { sha256Hex } from "../../ai-review/lib/base64";
import { createDb } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import {
  renderOrderSheetXlsx,
  toXlsxInput,
  TooManyLines,
  type XlsxPicture,
} from "../lib/order-sheet-xlsx";
import { todayIsoDate } from "../lib/cell-text";
import { readOrderSheet } from "./order-sheet-reader";

/**
 * ★ ORDER SHEET を xlsx にして返し、**R2 にも残す**。
 *
 * ⚠ 残すのは「いつ出したものか」を後から見せられるようにするため
 *   (承認したときの現物が要る)。鍵に日時を入れるので**版が積み上がる**。
 * ⚠ **ファイル名に固有名詞を入れない。** 案件番号か製造番号。
 *   `caseLabel` は取引先名から作られているので使わない。
 */

export { TooManyLines };

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 契約の欄の値を文字にする（数値も来うる）。 */
function asName(value: string | number | boolean | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** ファイル名に使ってよい文字だけにする。 */
function safeName(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

export interface ExportedOrderSheet {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  /** R2 に残せたときだけ入る。残せなくてもダウンロードは成立する。 */
  fileId: string | null;
}

export async function exportOrderSheetXlsx(
  env: Bindings,
  caseId: string,
  options: { issuedOn?: string } = {},
): Promise<ExportedOrderSheet> {
  /*
   * ⚠ 以前は `order_sheets` を引いてファイル名の PO / SO を取っていた。
   *   ヘッダの値が `cells_json` に移って**画面の契約から取れる**ようになったので、
   *   この口から D1 を引くのは写真のぶん (`loadPictures`) だけになった。
   */
  const sheet = await readOrderSheet(env, caseId);

  // ⚠ 画面の `J12` も同じ関数で「いま出したら入る日」を出している（reader）。
  const issuedOn = options.issuedOn ?? todayIsoDate();
  const input = toXlsxInput(sheet, { issuedOn });
  /*
   * ⚠ 値の行は目印、継ぎ行は番地で入れる（分担と順番は `renderOrderSheetXlsx()` が持つ）。
   * ⚠⚠ 枠は**明細の数だけ**になり、合計は最後の枠から 1 行空けた行に出る。
   */
  const bytes = await renderOrderSheetXlsx(input, await loadPictures(env, sheet));

  /*
   * ⚠⚠ **ファイル名は発注No**（`J7` = お客様の発注No）。
   *   以前は `so_no ?? po_no` の物理列を引いていたが、ヘッダの値が
   *   `cells_json` に移ったので**画面に出ている値から作る**（引き直しを 1 本減らせた）。
   * ⚠ 社内の SO / PO は人が打つ欄で空のことが多い。**発注No は AI が埋めるので必ず入る。**
   * ⚠ **固有名詞は入れない**。番号だけなのでこのまま。
   */
  const id =
    safeName(asName(sheet.header.J7?.value)) ??
    safeName(asName(sheet.header.F12?.value)) ??
    safeName(asName(sheet.header.D12?.value)) ??
    safeName(caseId) ??
    "case";
  const filename = `ORDER_SHEET_${id}.xlsx`;

  const fileId = await storeExport(env, { caseId, bytes, filename });
  return { bytes, filename, contentType: XLSX_CONTENT_TYPE, fileId };
}

/**
 * R2 に残す。
 * ⚠ **失敗してもダウンロードは通す。** 残せないことと、現場が受け取れないことは別。
 */
async function storeExport(
  env: Bindings,
  input: { caseId: string; bytes: Uint8Array; filename: string },
): Promise<string | null> {
  try {
    const db = createDb(env);
    const fileId = uuidv7();
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const storageKey = `order-sheets/${input.caseId}/${stamp}.xlsx`;

    // ⚠ R2 を先に書く。D1 だけ書けて R2 が落ちると、開けない台帳の行が残る。
    await env.FILES_BUCKET.put(storageKey, input.bytes as unknown as ArrayBuffer, {
      httpMetadata: { contentType: XLSX_CONTENT_TYPE },
    });

    await db.insert(files).values({
      id: fileId,
      kind: "order_sheet_xlsx",
      storageKey,
      originalFilename: input.filename,
      contentType: XLSX_CONTENT_TYPE,
      byteSize: input.bytes.byteLength,
      sha256: await sha256Hex(input.bytes.buffer as ArrayBuffer),
      // ⚠ 人が上げたものではなく、こちらが作ったもの。
      receivedVia: "generated",
      uploadedAt: new Date(),
    });
    return fileId;
  } catch (error) {
    console.warn(`[order-sheets] ${input.caseId} の xlsx を R2 に残せませんでした`, error);
    return null;
  }
}

/** その案件で出した xlsx の一覧 (新しい順)。承認したときの現物を見せるため。 */
export async function listExports(env: Bindings, caseId: string) {
  const db = createDb(env);
  return db
    .select({
      fileId: files.id,
      filename: files.originalFilename,
      byteSize: files.byteSize,
      uploadedAt: files.uploadedAt,
    })
    .from(files)
    .where(
      and(
        eq(files.kind, "order_sheet_xlsx"),
        like(files.storageKey, `order-sheets/${caseId}/%`),
        isNull(files.deletedAt),
      ),
    )
    .orderBy(files.uploadedAt);
}

/**
 * ★ Picture 欄に貼る絵を R2 から取る。**1 明細 1 枚**（代表 = 生きている先頭）。
 *
 * ⚠ 画面の契約には R2 の鍵を載せない（要らない値を流さない）ので、ここで `files` を引く。
 * ⚠⚠ **取れなかった絵は名指しで warn して飛ばす。** 写真 1 枚のせいでダウンロードを
 *   落とさない（xlsx は出る、その絵だけが無い）。
 */
async function loadPictures(
  env: Bindings,
  sheet: Awaited<ReturnType<typeof readOrderSheet>>,
): Promise<XlsxPicture[]> {
  const wanted = sheet.lines
    .map((line, lineIndex) => ({ lineIndex, fileId: line.photos[0]?.fileId ?? null }))
    .filter((row): row is { lineIndex: number; fileId: string } => row.fileId !== null);
  if (wanted.length === 0) return [];

  const rows = await createDb(env)
    .select({ id: files.id, storageKey: files.storageKey, contentType: files.contentType })
    .from(files)
    .where(inArray(files.id, [...new Set(wanted.map((row) => row.fileId))]));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const pictures: XlsxPicture[] = [];
  for (const { lineIndex, fileId } of wanted) {
    const file = byId.get(fileId);
    if (!file) {
      console.warn(`[order-sheets] 明細 ${lineIndex + 1} の写真が files にありません: ${fileId}`);
      continue;
    }
    const body = await readBytes(env, file.storageKey);
    if (!body) {
      console.warn(`[order-sheets] 明細 ${lineIndex + 1} の写真を R2 から取れませんでした`);
      continue;
    }
    pictures.push({
      lineIndex,
      bytes: new Uint8Array(body),
      // ⚠ R2 の鍵の拡張子は必ず `.jpg` だが、**本当の形式は files の列**が持つ。
      contentType: file.contentType ?? "image/jpeg",
    });
  }
  return pictures;
}
