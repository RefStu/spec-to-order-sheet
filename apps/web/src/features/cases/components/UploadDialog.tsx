import { useEffect, useRef, useState } from "react";
import { Button } from "../../../shared/ui/button";
import { TrashIcon } from "../../../shared/ui/icons";

/**
 * ★ 発注書をアップロードするダイアログ。
 *
 * ⚠ **ネイティブの `<dialog>` + `showModal()`。** `window.confirm` は以降のイベントを
 *   止めてしまう。見本は DeleteDocumentDialog.tsx。
 * ⚠ **選んだファイルが一覧で残る。**取り消せるので、間違えても選び直さなくてよい。
 * ⚠⚠ **アップロードは PDF 1 通 = 1 POST。** 複数を 1 案件にまとめるのは呼ぶ側の仕事
 *   (1 通目の応答の caseId を 2 通目以降に渡す)。ここは「何を送るか」を決めるだけ。
 * ⚠ いまは PDF だけ。受け付ける形式の正は `features/files/schema.ts` の 1 か所。
 */
export function UploadDialog({
  open,
  accept,
  pending,
  progressText,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  /** `<input accept>` に渡す形式。**画面で決め打ちしない。** */
  accept: string;
  pending: boolean;
  /** 取り込み中に出す進み具合 (「2 通目を送っています…」など)。 */
  progressText?: string;
  onCancel: () => void;
  onSubmit: (files: File[]) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // ⚠ `open` 属性ではなく showModal()。属性だけだと背面が操作でき、Esc も効かない。
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) setFiles([]);
  }, [open]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const file of Array.from(list)) {
        // 同じファイルを 2 回選んでも 1 つだけにする (名前と大きさで見る)。
        if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
        next.push(file);
      }
      return next;
    });
    // ⚠ value を空にしないと、同じファイルを選び直しても change が起きない。
    if (input.current) input.current.value = "";
  }

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      className="w-[32rem] max-w-[90vw] rounded-lg border border-border bg-surface p-5 text-ink backdrop:bg-ink/30"
    >
      <h2 className="text-base font-semibold">発注書をアップロード</h2>
      <p className="mt-1 text-sm text-ink-muted">
        発注書と依頼書の PDF を選んでください。1 つの PDF に両方が入っていても構いません。
        選んだものは同じ発注にまとまります。
      </p>

      <input
        ref={input}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(e) => addFiles(e.target.files)}
      />

      <div className="mt-4 flex flex-col gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => input.current?.click()}
          disabled={pending}
        >
          ファイルを選ぶ
        </Button>

        {files.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-ink-muted">
            まだ選ばれていません
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.map((file) => (
              <li
                key={`${file.name}:${file.size}`}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <span className="flex-1 truncate">{file.name}</span>
                <span className="text-xs text-ink-muted">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  type="button"
                  aria-label={`${file.name} を取り消す`}
                  disabled={pending}
                  onClick={() =>
                    setFiles((prev) =>
                      prev.filter((f) => !(f.name === file.name && f.size === file.size)),
                    )
                  }
                  className="rounded p-1 text-ink-muted hover:bg-surface-muted hover:text-ink"
                >
                  <TrashIcon width={14} height={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pending && progressText ? (
        <p className="mt-3 text-sm text-ink-muted">{progressText}</p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          やめる
        </Button>
        <Button onClick={() => onSubmit(files)} disabled={pending || files.length === 0}>
          {pending ? "取り込んでいます…" : "ORDER SHEET の作成"}
        </Button>
      </div>
    </dialog>
  );
}
