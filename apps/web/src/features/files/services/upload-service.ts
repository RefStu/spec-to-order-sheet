import { eq } from "drizzle-orm";
import { uuidv7 } from "../../ai-review/lib/uuid-v7";
import { sha256Hex } from "../../ai-review/lib/base64";
import { createDb } from "../../../shared/db";
import type { Bindings } from "../../../shared/hono";
import { files } from "../db/schema";
import {
  ACCEPTED_CONTENT_TYPES,
  isAcceptedContentType,
  MAX_UPLOAD_BYTES,
  PDF_CONTENT_TYPE,
} from "../schema";

export interface StoredFile {
  fileId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  /** 同じ内容の PDF が既にあった (二重取り込み)。 */
  duplicated: boolean;
}

export class UploadRejected extends Error {}

/**
 * PDF を R2 に預け、`files` に 1 行作る。
 *
 * ⚠ 実体は R2、D1 には**参照だけ**を持つ。
 * ⚠ 同じ内容の PDF が既にあれば**入れ直さず既存を返す**。`files.storage_key` は UNIQUE で、
 *   同じ発注書を 2 回上げると案件も読み取りも二重になるため。
 */
export async function storeDocument(
  env: Bindings,
  input: { filename: string; contentType: string; body: ArrayBuffer },
): Promise<StoredFile> {
  // ⚠ 受け付ける形式の正は `files/schema.ts` の 1 か所だけ (増やすときもそこ)。
  if (!isAcceptedContentType(input.contentType)) {
    throw new UploadRejected(
      `受け付けられない形式です (${input.contentType})。いま受け付けるのは ${ACCEPTED_CONTENT_TYPES.join(" / ")} です`,
    );
  }
  if (input.body.byteLength === 0) throw new UploadRejected("中身が空のファイルです");
  if (input.body.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(
      `ファイルが大きすぎます (上限 ${MAX_UPLOAD_BYTES} バイト / 受け取った ${input.body.byteLength} バイト)`,
    );
  }

  const db = createDb(env);
  const sha256 = await sha256Hex(input.body);

  const [existing] = await db
    .select({ id: files.id, storageKey: files.storageKey, byteSize: files.byteSize })
    .from(files)
    .where(eq(files.sha256, sha256))
    .limit(1);
  if (existing) {
    return {
      fileId: existing.id,
      storageKey: existing.storageKey,
      sha256,
      byteSize: existing.byteSize,
      duplicated: true,
    };
  }

  const fileId = uuidv7();
  // ⚠ **種類でフォルダを分けない。** 届いた時点では何が入っているか分からない
  //   (読み取りの結果で決まる)。届いた原本はすべてここに置く。
  const storageKey = `documents/inbound/${fileId}.pdf`;

  // ⚠ R2 を先に書く。D1 だけ書けて R2 が落ちると、開けない台帳の行が残る。
  await env.FILES_BUCKET.put(storageKey, input.body, {
    httpMetadata: { contentType: PDF_CONTENT_TYPE },
  });

  await db.insert(files).values({
    id: fileId,
    // ⚠ 取り込みの入口に届いた原本。中身の種類は読んでから `po_documents.doc_kind` に入る。
    kind: "customer_po",
    storageKey,
    originalFilename: input.filename,
    contentType: input.contentType,
    byteSize: input.body.byteLength,
    sha256,
    // PoC は画面からのアップロードだけ。メールや FAX は受けない。
    receivedVia: "upload",
    uploadedAt: new Date(),
  });

  return { fileId, storageKey, sha256, byteSize: input.body.byteLength, duplicated: false };
}

/**
 * 依頼書から切り出した**代表の図**を預ける (R2 + `files` 1 行)。
 *
 * ⚠⚠ **保存先の鍵を依頼書の ID と「何枚目か」から決める。** `files` にはどの帳票から
 *   来たかを持つ列が無いので、`storage_key` (UNIQUE) を橋にする。ORDER SHEET を
 *   起こすときは接頭辞 (`photoStorageKeyPrefix`) で引ける。
 * ⚠ **読み取りをやり直したら上書きする。** 同じ鍵なので R2 も `files` も 1 行に収束する
 *   (写真が版ごとに溜まらない)。
 * ⚠ ここは受け口ではないので `ACCEPTED_CONTENT_TYPES` (PDF だけ) は通らない。
 *   中身を作ったのはこちら側なので、形式の検査は要らない。
 */
export async function storePhoto(
  env: Bindings,
  input: {
    /** どの依頼書の代表の図か。 */
    revisionRequestId: string;
    /** その依頼書の**何枚目**の絵か (0 から)。1 依頼書に複数枚あることがある。 */
    pictureIndex?: number;
    body: ArrayBuffer;
    contentType: string;
  },
): Promise<{ fileId: string; storageKey: string }> {
  const db = createDb(env);
  const pictureIndex = input.pictureIndex ?? 0;
  const storageKey = photoStorageKey(input.revisionRequestId, pictureIndex);
  const sha256 = await sha256Hex(input.body);

  await env.FILES_BUCKET.put(storageKey, input.body, {
    httpMetadata: { contentType: input.contentType },
  });

  const [existing] = await db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.storageKey, storageKey))
    .limit(1);

  /*
   * ⚠⚠ **`deletedAt: null` に戻さない。** 戻すと読み直しのたびに `files` の論理削除が
   *   巻き戻る。そもそも「人が外した」を持つのは `order_sheet_line_photos.deleted_at`
   *   **だけ**で、`files` に人の判断は載せない (1 枚の依頼書が複数の明細に結ばれるので、
   *   `files` を降ろすと関係のない明細の Picture まで消える)。
   */
  const common = {
    contentType: input.contentType,
    byteSize: input.body.byteLength,
    sha256,
    uploadedAt: new Date(),
  };
  if (existing) {
    await db.update(files).set(common).where(eq(files.id, existing.id));
    return { fileId: existing.id, storageKey };
  }

  const fileId = uuidv7();
  await db.insert(files).values({
    id: fileId,
    kind: "item_photo",
    storageKey,
    // ⚠ 鍵と同じ名前にする (1 枚目は接尾辞なし)。画面の保存名になる。
    originalFilename: storageKey.slice(storageKey.lastIndexOf("/") + 1),
    // 人が上げたのではなく、読み取りの途中で作ったもの。
    receivedVia: "generated",
    ...common,
  });
  return { fileId, storageKey };
}

/** 人が上げた代表の図が jpeg / png ではない (415)。 */
export class UnsupportedPhotoType extends Error {}

/**
 * 人が上げる代表の図として受け付ける形式。
 *
 * ⚠ **jpeg と png だけ。** xlsx に埋め込めるのがこの 2 つだけ
 *   (`order-sheets/lib/xlsx-drawing.ts`)。増やすならあちらが先。
 */
export const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png"] as const;
export type AcceptedPhotoType = (typeof ACCEPTED_PHOTO_TYPES)[number];

/**
 * 中身の先頭のバイトから形式を決める。**申告の `content-type` は信じない。**
 *
 * ⚠ 名前だけ `.jpg` の別物を通すと、画面では開けても **xlsx が壊れる**
 *   (拡張子と中身が食い違った画像を Excel は開かない)。
 */
export function sniffPhotoType(body: ArrayBuffer): AcceptedPhotoType | null {
  const head = new Uint8Array(body, 0, Math.min(body.byteLength, 8));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length === png.length && png.every((byte, index) => head[index] === byte)) {
    return "image/png";
  }
  return null;
}

/**
 * ★ **人が画面から上げた**代表の図を預ける (R2 + `files` 1 行)。
 *
 * ⚠⚠ **鍵は `photos/manual/<fileId>.<ext>`。`photos/spec/` にしない。**
 *   generator は `photos/spec/<依頼書>` の接頭辞と `parsePhotoStorageKey()` で
 *   「依頼書から切り出した絵」を拾う。そこに混ぜると、読み直しで**別の依頼書の絵**として
 *   扱われる。人が上げた絵は `order_sheet_line_photos` の行だけが明細と結ぶ。
 * ⚠ 同じ中身でも**入れ直す** (`storeDocument` のように既存を返さない)。既存の `file_id` を
 *   返すと、外した絵を同じ明細に上げ直したときに `(明細, file_id)` の一意索引に当たり、
 *   **外した行 (墓標) とぶつかって上げられない**。
 */
export async function storeUploadedPhoto(
  env: Bindings,
  input: { filename: string; body: ArrayBuffer; uploadedBy: string | null },
): Promise<{ fileId: string; storageKey: string }> {
  if (input.body.byteLength === 0) throw new UploadRejected("中身が空のファイルです");
  if (input.body.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(
      `ファイルが大きすぎます (上限 ${MAX_UPLOAD_BYTES} バイト / 受け取った ${input.body.byteLength} バイト)`,
    );
  }
  const contentType = sniffPhotoType(input.body);
  if (contentType === null) {
    throw new UnsupportedPhotoType(
      `代表の図として受け付けられない形式です。いま受け付けるのは ${ACCEPTED_PHOTO_TYPES.join(" / ")} です`,
    );
  }

  const db = createDb(env);
  const fileId = uuidv7();
  const storageKey = `photos/manual/${fileId}.${contentType === "image/png" ? "png" : "jpg"}`;

  // ⚠ R2 を先に書く。D1 だけ書けて R2 が落ちると、開けない台帳の行が残る。
  await env.FILES_BUCKET.put(storageKey, input.body, { httpMetadata: { contentType } });

  await db.insert(files).values({
    id: fileId,
    kind: "item_photo",
    storageKey,
    originalFilename: input.filename,
    contentType,
    byteSize: input.body.byteLength,
    sha256: await sha256Hex(input.body),
    // ⚠ 読み取りが作ったもの (`generated`) と分ける。人が画面から上げた。
    receivedVia: "upload",
    uploadedBy: input.uploadedBy,
    uploadedAt: new Date(),
  });
  return { fileId, storageKey };
}

/**
 * 代表の図の保存先の鍵。**この式は 1 か所だけ**(書く側と引く側で共有する)。
 *
 * ⚠ **1 枚目は接尾辞なし。** 既にある鍵 (`photos/spec/<id>.jpg`) をそのまま保つため。
 * ⚠ **区切りは `_`。** `revisionRequestId` は uuidv7 (16 進と `-` だけ) なので、`-` を
 *   使うと `<id>-1.jpg` が「id が `<id>-1` の 1 枚目」とも読めて `parsePhotoStorageKey()`
 *   が曖昧になる。`_` は id に現れない。
 */
export function photoStorageKey(revisionRequestId: string, pictureIndex = 0): string {
  const prefix = photoStorageKeyPrefix(revisionRequestId);
  return pictureIndex === 0 ? `${prefix}.jpg` : `${prefix}_${pictureIndex}.jpg`;
}

/**
 * その依頼書の絵をまとめて引くための接頭辞 (generator が `like` で使う)。
 * ⚠ `photoStorageKey()` と**同じ式**から作る。片方だけ直さない。
 */
export function photoStorageKeyPrefix(revisionRequestId: string): string {
  return `photos/spec/${revisionRequestId}`;
}

/**
 * 鍵を (依頼書, 何枚目) に開く。**`photoStorageKey()` と対**。片方だけ直さない。
 *
 * ⚠ 形が違う鍵 (別の用途のオブジェクト) には `null` を返す。呼ぶ側はそれを捨てる
 *   ことで、`like` の接頭辞が別の依頼書に当たった場合もふるい落とせる。
 */
export function parsePhotoStorageKey(
  storageKey: string,
): { revisionRequestId: string; pictureIndex: number } | null {
  const matched = /^photos\/spec\/([^/]+?)(?:_(\d+))?\.jpg$/.exec(storageKey);
  if (!matched) return null;
  return { revisionRequestId: matched[1]!, pictureIndex: matched[2] ? Number(matched[2]) : 0 };
}

/** 原本 PDF を返す (画面が案件詳細から開く)。 */
export async function readOriginal(
  env: Bindings,
  fileId: string,
): Promise<{ body: ReadableStream; contentType: string; filename: string } | null> {
  const db = createDb(env);
  const [row] = await db
    .select({
      storageKey: files.storageKey,
      contentType: files.contentType,
      originalFilename: files.originalFilename,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  if (!row) return null;

  const object = await env.FILES_BUCKET.get(row.storageKey);
  if (!object) return null;

  return {
    body: object.body as unknown as ReadableStream,
    contentType: row.contentType,
    filename: row.originalFilename,
  };
}

/** 読み取りのために R2 から中身を取る (consumer が使う)。 */
export async function readBytes(env: Bindings, storageKey: string): Promise<ArrayBuffer | null> {
  const object = await env.FILES_BUCKET.get(storageKey);
  return object ? await object.arrayBuffer() : null;
}
