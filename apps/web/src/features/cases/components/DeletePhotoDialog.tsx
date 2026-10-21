import { useEffect, useRef } from "react";
import { Button } from "../../../shared/ui/button";

/**
 * ★ 代表の図を 1 枚外す前の確認。**確認を挟むのは元に戻せない操作だから。**
 *
 * ⚠⚠ **読み取りをやり直しても戻らない。** 外した記録は
 *   `order_sheet_line_photos.deleted_at` に残り、生成のたびに「同じ絵は差し込まない」
 *   判断に使われる (`services/order-sheet-generator.ts`)。
 * ⚠ **原本 (帳票の PDF) は消えない。** 消えるのは ORDER SHEET のこの明細に付いた絵だけ。
 * ⚠ **`window.confirm` を使わない。** ブラウザのモーダルは以降のイベントを止める。
 *   ネイティブの `<dialog>` なら Esc とフォーカストラップが付いてくる。
 * ⚠ **ここで可否を判定しない。** `released` かどうかを決めるのは API の 1 か所
 *   (帳票の取り消しのダイアログと同じ作法)。
 */
export function DeletePhotoDialog({
  open,
  lineNo,
  pending,
  onCancel,
  onConfirm,
}: {
  /** 外そうとしている絵がある (= 開いている)。 */
  open: boolean;
  /** 何行目の明細の絵か。 */
  lineNo: number | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      className="w-[30rem] max-w-[90vw] rounded-lg border border-border bg-surface p-5 text-ink backdrop:bg-ink/30"
    >
      <h2 className="text-base font-semibold">この代表の図を外しますか</h2>

      {lineNo === null ? null : (
        <p className="mt-3 text-sm text-ink-muted">{lineNo} 行目の明細の絵です。</p>
      )}

      <ul className="mt-4 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
        <li>この明細の Picture 欄から外します。残りがあれば次の絵が代表になります。</li>
        <li>原本 (届いた帳票) は残ります。</li>
      </ul>

      <p className="mt-3 text-sm font-medium text-danger">読み取りをやり直しても戻りません。</p>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          やめる
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={pending}>
          {pending ? "外しています…" : "外す"}
        </Button>
      </div>
    </dialog>
  );
}
