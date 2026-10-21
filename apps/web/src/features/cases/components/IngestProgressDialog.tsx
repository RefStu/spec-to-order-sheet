import { useEffect, useRef } from "react";
import { Button } from "../../../shared/ui/button";
import { cn } from "../../../shared/ui/cn";
import { SpinnerIcon } from "../../../shared/ui/icons";
import { elapsedLabel, ingestStageLabel } from "../lib/format";
import type { IngestStageView, StageStatus } from "../lib/progress";

/**
 * ★★ 読み取りの進み具合。**段を縦に並べて出す。**
 *
 * ```
 *  ✓  発注書フォーマットを分類
 *  │
 *  ⟳  各パラメーターの値を抽出
 *  │    ✓  発注書
 *  │    ⟳  依頼書 1 枚目
 *  │    ·  依頼書 2 枚目        (待機)
 *  │
 *  ·  抽出結果を整形
 *  │
 *  ·  完了
 * ```
 *
 * ⚠⚠ **横の矢印にしない。** 段は縦、並列のノードは**その段の下に 1 段字下げして縦**。
 *   枚数は分類してみるまで分からない (`lib/group-parts.ts`) ので、増えても形が崩れない
 *   並べ方でないといけない。
 * ⚠⚠ **並列であることは「同時に ⟳ が複数点いていること」で見せる。**
 *   ai の並列度は 3 (`SPEC_SHEET_CONCURRENCY`) なので、4 枚目以降は待機のまま残る。
 *   **それが正しい表示**なので、待機を隠さないこと。
 * ⚠ 段の正は `lib/progress.ts` の `stagesOf()`、日本語は `lib/format.ts`。
 *   **ここに判断を書かない** (2 か所になると必ずずれる)。
 * ⚠ **`window.confirm` を使わない。** ネイティブの `<dialog>`。見本は DeleteDocumentDialog.tsx。
 * ⚠ このダイアログは**閉じても読み取りは止まらない** (走っているのはキューの consumer)。
 *   閉じたあとの手がかりは ORDER SHEET のチップが持つ。
 */
export function IngestProgressDialog({
  open,
  stages,
  ingestingSince,
  onClose,
}: {
  open: boolean;
  stages: readonly IngestStageView[];
  /** いつから読み取り中か (ISO)。**回り続けるスピナー以外の手がかり。** */
  ingestingSince: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const elapsed = elapsedLabel(ingestingSince);

  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      className="w-[32rem] max-w-[90vw] rounded-lg border border-border bg-surface p-5 text-ink backdrop:bg-ink/30"
    >
      <h2 className="text-base font-semibold">AI が読み取っています</h2>
      {elapsed ? <p className="mt-1 text-xs text-ink-muted">{elapsed}</p> : null}

      <ol className="mt-4 flex flex-col">
        {stages.map((stage, index) => (
          <li key={stage.stage}>
            <div className="flex items-start gap-2">
              <StatusMark status={stage.status} />
              <span
                className={cn(
                  "text-sm",
                  stage.status === "pending" && "text-ink-muted",
                  stage.status === "running" && "font-medium",
                  stage.status === "failed" && "text-danger",
                )}
              >
                {ingestStageLabel(stage.stage)}
              </span>
            </div>

            {/*
              ⚠⚠ **並列のノードはここ。** 段の下に 1 段字下げして縦に並べる。
                横に並べない — 枚数が実行時に決まるので、増えると折り返して読めなくなる。
            */}
            {stage.nodes.length > 0 ? (
              <ul className="ml-[0.4375rem] border-l border-border pl-4">
                {stage.nodes.map((node) => (
                  <li key={node.node} className="flex items-start gap-2 py-0.5">
                    <StatusMark status={node.status} />
                    <span
                      className={cn(
                        "text-sm",
                        node.status === "pending" && "text-ink-muted",
                        node.status === "failed" && "text-danger",
                      )}
                    >
                      {node.label}
                      {node.status === "pending" ? (
                        <span className="ml-1 text-xs text-ink-muted">(待機)</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : index < stages.length - 1 ? (
              // 段と段をつなぐ縦線 (ノードが無い段)。
              <div className="ml-[0.4375rem] h-3 border-l border-border" />
            ) : null}
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-ink-muted">
        閉じても読み取りは続きます。終わると画面が自動で入れ替わります。
      </p>

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </dialog>
  );
}

/** ⚠ 進行中だけが回る。**待機・済・失敗は動かさない** (全部回ると何も伝わらない)。 */
function StatusMark({ status }: { status: StageStatus }) {
  if (status === "running") {
    return (
      <span className="mt-0.5 text-brand" aria-label="処理中">
        <SpinnerIcon width={14} height={14} />
      </span>
    );
  }
  const mark = status === "succeeded" ? "✓" : status === "failed" ? "✗" : "·";
  const label = status === "succeeded" ? "完了" : status === "failed" ? "失敗" : "待機";
  return (
    <span
      aria-label={label}
      className={cn(
        "mt-px w-3.5 text-center text-sm leading-4",
        status === "succeeded" && "text-brand",
        status === "failed" && "text-danger",
        status === "pending" && "text-ink-muted",
      )}
    >
      {mark}
    </span>
  );
}
