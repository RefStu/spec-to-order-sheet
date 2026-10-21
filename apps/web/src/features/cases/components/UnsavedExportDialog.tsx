import { useEffect, useRef } from "react";
import { Button } from "../../../shared/ui/button";
import type { FieldValue } from "../lib/order-sheet-contract";
import type { UnsavedItem } from "../lib/order-sheet-draft";

/**
 * ★ 「xlsx で出す」を押したとき、まだ保存していない項目があれば確認する。
 *
 * ⚠⚠ **xlsx は D1 の保存済みの値から作る。** 保存せずに出すと、画面で打った文字が
 *   xlsx に**黙って入らない**。どちらで出すかは人に選ばせる。
 * ⚠ **`window.confirm` を使わない。** ブラウザのモーダルは以降のイベントを止める。
 *   ネイティブの `<dialog>` なら Esc とフォーカストラップが付いてくる。
 */
export function UnsavedExportDialog({
  items,
  pending,
  error,
  onCancel,
  onSaveAndExport,
  onExportAsIs,
}: {
  /** 未保存の項目。null なら閉じている。 */
  items: readonly UnsavedItem[] | null;
  /** 保存か書き出しの最中。 */
  pending: boolean;
  /** 保存に失敗したときの理由。⚠ 下書きは残っているので、そのまま選び直せる。 */
  error?: string;
  onCancel: () => void;
  onSaveAndExport: () => void;
  onExportAsIs: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (items && !dialog.open) dialog.showModal();
    if (!items && dialog.open) dialog.close();
  }, [items]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        // ⚠ 保存中に Esc で閉じると、保存のあとに書き出しだけが走って見える。
        if (pending) e.preventDefault();
        else onCancel();
      }}
      className="w-[36rem] max-w-[90vw] rounded-lg border border-border bg-surface p-5 text-ink backdrop:bg-ink/30"
    >
      <h2 className="text-base font-semibold">保存していない項目があります</h2>
      <p className="mt-2 text-sm text-ink-muted">
        xlsx は保存済みの内容から作ります。このまま出すと、次の {items?.length ?? 0}{" "}
        項目は xlsx に入りません。
      </p>

      <ul className="mt-3 flex max-h-72 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border text-sm">
        {(items ?? []).map((item) => (
          <li key={item.key} className="flex flex-col gap-0.5 px-3 py-2">
            <span className="font-medium">{item.label}</span>
            <span className="break-all text-ink-muted">
              {textOf(item.saved)} <span aria-hidden>→</span>
              <span className="sr-only">から</span>{" "}
              <span className="text-ink">{textOf(item.draft)}</span>
            </span>
          </li>
        ))}
      </ul>

      {error ? <p className="mt-3 text-sm font-medium text-danger">{error}</p> : null}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          やめる
        </Button>
        <Button variant="outline" onClick={onExportAsIs} disabled={pending}>
          保存せずに出す
        </Button>
        <Button onClick={onSaveAndExport} disabled={pending}>
          {pending ? "保存しています…" : "保存してから出す"}
        </Button>
      </div>
    </dialog>
  );
}

/** ⚠ 空は「（空）」と書く（空文字のままだと何が変わったのか読めない）。 */
function textOf(value: FieldValue): string {
  return value === null || value === undefined || value === "" ? "（空）" : String(value);
}
