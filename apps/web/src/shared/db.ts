import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * D1 (Drizzle)。
 *
 * ⚠ **機能の知識を持たない。** テーブルの定義は features/<name>/db/schema.ts にあり、
 *   ここは接続だけを作る。schema を渡さないので、クエリは `db.select().from(table)` の形で書く。
 * ⚠ リクエストごとに作る。Worker のモジュールスコープに置くと env を読めない。
 */
export interface DbEnv {
  DB: D1Database;
}

export function createDb(env: DbEnv) {
  return drizzle(env.DB);
}

/** `createDb()` が返すもの。writer を「文を組み立てるだけ」の純関数にするために使う。 */
export type Db = ReturnType<typeof createDb>;

/**
 * まだ実行していない 1 文。`db.insert(...)` などがそのまま入る。
 *
 * ⚠ **1 つの batch にまとめて流すと D1 のトランザクションになる**(1 往復)。
 *   「前の版を取り下げてから書き直す」を途中で割らせないために使う。
 */
export type DbStatement = BatchItem<"sqlite">;

/**
 * 文をまとめて 1 トランザクションで流す。
 *
 * ⚠ drizzle の `batch` は**空でない**配列を要求する (型がタプル)。空のときは何もしない。
 */
export async function runBatch(db: Db, statements: readonly DbStatement[]): Promise<void> {
  if (statements.length === 0) return;
  await db.batch(statements as unknown as [DbStatement, ...DbStatement[]]);
}

/**
 * ⚠⚠ **D1 は 1 文あたりの bind 変数を 100 個までしか受け付けない。**
 *
 * drizzle の `insert().values([...])` は行数 × 列数ぶんの `?` を 1 文に並べるので、
 * 行が増えると **`D1_ERROR: too many SQL variables`** で落ちる。
 * これは通しの確認で実際に起きた (3 明細の発注書で欄 26 行 × 12 列 = 312 個)。
 * しかも落ちる場所がキューの consumer なので `message.retry()` に入り、
 * **同じ帳票の読み取りが最大 3 回走って DLQ へ落ちる。**
 *
 * ⚠ 行数は入力しだいで決まる (明細の数 / 欄の数)。**「いまは足りている」で判断しない。**
 *   複数行を入れるところは必ずここを通すこと。
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** 1 文に収まる行数で分ける。列数は行のキーの数から測る (drizzle が並べる `?` の数)。 */
export function chunkForD1<T extends Record<string, unknown>>(rows: readonly T[]): T[][] {
  if (rows.length === 0) return [];
  const columns = Math.max(1, ...rows.map((row) => Object.keys(row).length));
  const perStatement = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columns));

  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    chunks.push(rows.slice(i, i + perStatement));
  }
  return chunks;
}

/**
 * 複数行を、D1 の上限に収まる単位に分けて入れる。
 *
 * ⚠ **1 文ずつ順に投げるので、途中で落ちると半分だけ入る。** 呼ぶ側が版を持っていて
 *   (`ai_extractions.is_current`)、やり直しで新しい版に倒せることを前提にしている。
 *   そうでない表をここで入れるときは、呼ぶ側で後片付けを用意すること。
 */
export async function insertInChunks<T extends Record<string, unknown>>(
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (const chunk of chunkForD1(rows)) {
    await insert(chunk);
  }
}
