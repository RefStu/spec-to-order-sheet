import { useEffect, useRef } from "react";
import { Button } from "../../../shared/ui/button";
import { docKindLabel } from "../lib/format";
import type { DocumentList } from "../lib/order-sheet-contract";

type CaseDocument = DocumentList["documents"][number];

/**
 * ★ 帳票を取り消す前の確認。**確認を挟むのは元に戻せない操作だから。**
 *
 * ⚠⚠ **元に戻せない操作。** 記録としては残る (論理削除) が、画面からは消え、
 *   ORDER SHEET はその帳票を除いて組み直される。
 * ⚠ **`window.confirm` を使わない。** ブラウザのモーダルは以降のイベントを止める。
 *   ネイティブの `<dialog>` なら Esc とフォーカストラップが付いてくる。
 * ⚠ **ここで可否を判定しない。** `released` かどうかを決めるのは API の 1 か所
 *   (承認のダイアログと同じ作法)。
 */
export function DeleteDocumentDialog({
  document,
  pending,
  onCancel,
  onConfirm,
}: {
  /** 消そうとしている帳票。null なら閉じている。 */
  document: CaseDocument | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (document && !dialog.open) dialog.showModal();
    if (!document && dialog.open) dialog.close();
  }, [document]);

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      className="w-[30rem] max-w-[90vw] rounded-lg border border-border bg-surface p-5 text-ink backdrop:bg-ink/30"
    >
      <h2 className="text-base font-semibold">この帳票を取り消しますか</h2>

      {document ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">種類</dt>
          <dd>{docKindLabel(document.docKind)}</dd>
          <dt className="text-ink-muted">受領日</dt>
          <dd>{document.receivedOn ?? "—"}</dd>
          <dt className="text-ink-muted">読み取り</dt>
          <dd>{document.extractionStatus}</dd>
        </dl>
      ) : null}

      <ul className="mt-4 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
        <li>この帳票から読み取った発注書・依頼書も一緒に降ろします。</li>
        <li>ORDER SHEET は残った帳票だけで組み直します。</li>
        <li>記録としては残りますが、画面からは見えなくなります。</li>
      </ul>

      <p className="mt-3 text-sm font-medium text-danger">元に戻せません。</p>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          やめる
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={pending}>
          {pending ? "取り消しています…" : "取り消す"}
        </Button>
      </div>
    </dialog>
  );
}
