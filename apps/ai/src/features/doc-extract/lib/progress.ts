import type { DocExtractProgressEvent, DocumentClassification } from "../contract";

/**
 * ★★ 進捗を 1 件流す。**step から呼ぶ唯一の口。**
 *
 * ⚠⚠ **失敗を飲む。** 受け手 (web の Queue consumer) が切れても、読み取りは最後まで
 *   走りきらせる。進捗はあくまで「見せるためのもの」で、**読み取りの成否に関わらせない**。
 * ⚠ `writer` は workflow を `run.stream()` で回したときだけ本物が入る
 *   (`run.start()` の経路では何も流れない。だから戻り道の JSON ルートも壊れない)。
 * ⚠ `node` は実行のあいだ変わらない鍵。表示用の語 (`label`) を鍵にしないこと。
 */
export interface ProgressWriter {
  write(chunk: unknown): Promise<unknown> | unknown;
}

export async function emitProgress(
  writer: ProgressWriter | undefined,
  event: Omit<DocExtractProgressEvent, "type" | "at">,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ type: "progress", at: Date.now(), ...event });
  } catch {
    // ⚠ **黙って続ける。** ここで throw すると、進捗の都合で読み取りが落ちる。
  }
}

/**
 * ★★ **読み取りのノードの一覧。名前の正はここ 1 か所。**
 *
 * ⚠⚠ **分類が終わった時点で、これから走るノードが全部決まる** (`lib/group-parts.ts` が
 *   `parts` を組み立てたあと)。だから `classify` の終わりでこの一覧を `pending` として
 *   流せて、画面は走る前から「依頼書 3 枚目 (待機)」を出せる。
 * ⚠⚠ **`steps/extract.ts` が実際に走らせる単位と必ず揃えること。**
 *   発注書は**複数あっても 1 通目だけ**を読む (複数通の扱いは決めていないため)。ここがずれると、
 *   画面に「待機」のまま終わるノードが残る。
 * ⚠ `node` は鍵、`label` は表示用。**鍵に日本語を使わない** (語を変えると別物になる)。
 */
export function extractNodesOf(
  parts: DocumentClassification["parts"],
): { node: string; label: string }[] {
  const nodes: { node: string; label: string }[] = [];
  // ⚠ `steps/extract.ts` と同じ絞り方 (1 通目だけ)。
  if (parts.some((part) => part.role === "purchase_order")) {
    nodes.push({ node: "po", label: "発注書" });
  }
  const sheets = parts.filter((part) => part.role === "spec_sheet");
  sheets.forEach((_unused, index) => {
    nodes.push({ node: `spec-${index + 1}`, label: specSheetLabel(index) });
  });
  /*
   * ⚠⚠ **代表の図の場所は依頼書 1 枚につき 1 回**、欄の読み取りとは**別の呼び出し**
   *   (`steps/locate-pictures.ts`)。ここに足しておくと、分類の終わりに「待機」として流れる。
   * ⚠⚠ **段は `extract` のまま** (4 つ目の段を作らない)。web は段の文字列を 5 か所で
   *   持っていて、**知らない段の行は safeParse で黙って捨てられる**。
   *   ノードの鍵のほうは web では `z.string()` なので、**足すだけなら web は変えなくてよい**。
   */
  sheets.forEach((_unused, index) => {
    nodes.push({ node: pictureNodeKey(index), label: pictureNodeLabel(index) });
  });
  /*
   * ⚠⚠ **下部のメモのノードは載せない。** 画面の進捗に「下部のメモ (依頼書 n 枚目)」を
   *   出さないことにした。`steps/read-spec-notes.ts` も進捗を流さない。
   *   ⚠ ここにだけ戻すと、画面に「待機」のまま終わる行が残る (走っても流れないため)。
   */
  return nodes;
}

/**
 * 下部のメモのノードの呼び名。⚠ **失敗の名指しにだけ使う** (進捗には出さない)。
 */
export function noteNodeLabel(index: number): string {
  return `下部のメモ (${specSheetLabel(index)})`;
}

/** 代表の図の場所のノードの鍵。⚠ **鍵にローマ字以外を使わない。** */
export function pictureNodeKey(index: number): string {
  return `pic-${index + 1}`;
}

/** 同ノードの表示用の語。⚠ **失敗の名指しにも使う**ので、ここ 1 か所に持つ。 */
export function pictureNodeLabel(index: number): string {
  return `代表の図の場所 (${specSheetLabel(index)})`;
}

/** 依頼書 n 枚目の呼び名。⚠ **失敗の名指しにも使う**ので、ここ 1 か所に持つ。 */
export function specSheetLabel(index: number): string {
  return `依頼書 ${index + 1} 枚目`;
}
