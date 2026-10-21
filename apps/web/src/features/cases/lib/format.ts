import type { CaseProgress } from "../schema";
import type { IngestStage } from "./progress";

/**
 * ORDER SHEET が**あるかないか**だけを出す。
 *
 * ⚠⚠ **状態の名前 (「AI が起こした」「確認中」など) は画面に出さない。**
 *   `order_sheets.status` の値そのものは DB と遷移で使っているので**消していない** —
 *   出すのをやめただけ。状態の語彙の正は `order-sheets/db/schema.ts` の `status` の enum。
 * ⚠ 「無い」と「ある」を混ぜないこと。未作成は読み取りがまだ終わっていない案件でも出る。
 */
export function orderSheetPresenceLabel(status: string | null): string {
  return status ? "作成済み" : "未作成";
}

/**
 * ★★ 読み取りの**段**の日本語。画面はこの順に縦に並べる (`lib/progress.ts` の `INGEST_STAGES`)。
 *
 * ⚠⚠ **「分類中」と言い切らない。** ai が段を報告していないとき (戻り道の JSON ルート /
 *   古いジョブ) は、分類と抽出の境目が外から見えない。**嘘にならない文言**にしてある。
 * ⚠ `Record<IngestStage, string>` なので、段を足してここを忘れると typecheck で落ちる。
 */
const INGEST_STAGE_LABEL: Record<IngestStage, string> = {
  classify: "発注書フォーマットを分類",
  extract: "各パラメーターの値を抽出",
  shape: "抽出結果を整形",
  done: "完了",
};

export function ingestStageLabel(stage: IngestStage): string {
  return INGEST_STAGE_LABEL[stage];
}

/**
 * ⚠ `Record<CaseProgress, string>` にしてあるので、`schema.ts` の `progressSchema` に
 *   値を足してここを忘れると **typecheck で落ちる**。語彙のずれをここで止める。
 */
const PROGRESS: Record<CaseProgress, string> = {
  accepted: "受け付けた",
  reading: "読んでいる",
  written: "書き込んだ",
  failed: "失敗した",
};

export function progressLabel(progress: string | null): string | null {
  if (!progress) return null;
  return PROGRESS[progress as CaseProgress] ?? progress;
}

const DOC_KIND: Record<string, string> = {
  purchase_order: "発注書",
  spec_sheet: "依頼書",
};

export function docKindLabel(kind: string): string {
  return DOC_KIND[kind] ?? kind;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short" }).format(date);
}

/** 原本 PDF を開けなかった理由の文面 (hooks/use-cases.ts の OpenOriginalFailed)。 */
const OPEN_ORIGINAL_MESSAGE: Record<string, string> = {
  not_found: "原本が見つかりません。読み取りの前に消えた可能性があります。",
  // ⚠ 401 は apiFetch が既にサインアウトさせている。迂回はしない (経路を 2 つにしない)。
  signed_out: "サインインが切れました。入り直してください。",
  popup_blocked: "ブラウザが新しいタブを止めました。このサイトのポップアップを許可してください。",
  failed: "原本を開けませんでした。",
};

export function openOriginalMessage(reason: string, status?: number): string {
  const base = OPEN_ORIGINAL_MESSAGE[reason] ?? OPEN_ORIGINAL_MESSAGE.failed!;
  return status ? `${base} (${status})` : base;
}

/**
 * ★ 「いつから読み取り中か」を経過時間の言葉にする (`jobStatusResult.ingestingSince`)。
 *
 * ⚠ 回り続けるスピナーしか手がかりが無いと、人は「終わらない」のか「時間がかかっている」のかを
 *   区別できない。**経過時間が見えるだけで違う。**
 * ⚠ 秒は出さない (3 秒ごとのポーリングで数字が踊る)。1 分未満は「まもなく」。
 */
export function elapsedLabel(since: string | null, now: number = Date.now()): string | null {
  if (!since) return null;
  const startedAt = new Date(since).getTime();
  if (Number.isNaN(startedAt)) return null;

  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (minutes < 1) return "まもなく";
  if (minutes < 60) return `${minutes} 分経過`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 時間 ${minutes % 60} 分経過`;
}
