import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { TrashIcon, UploadIcon } from "../../../shared/ui/icons";
import { usePhotoUrl } from "../hooks/use-cases";
import type { OrderSheetLinePhoto } from "../lib/order-sheet-contract";

/**
 * 明細の **Picture** の中身。**1 明細に複数枚**あるので、1 枚ずつ出して送る。
 *
 * ⚠ 欄に入っているのは `files.id`。画像そのものは `GET /api/files/:fileId/original` に
 *   あり、`Authorization` が要るので **blob にしてから** `<img>` に渡す (`usePhotoUrl`)。
 * ⚠⚠ **hook は 1 つだけ呼ぶ。** 配列を map して `usePhotoUrl` を呼ぶと、枚数が変わった
 *   瞬間に hook の数が変わって React が落ちる。**いま見えている 1 枚だけ**を読む。
 * ⚠⚠ **ルートが `<label>`** (`OrderSheetField`) なので、中のボタンは
 *   `preventDefault` + `stopPropagation` しないと入力欄へフォーカスが飛ぶ。
 * ⚠ **取れなくても画面を落とさない。** 欄が空に見えるだけにする。
 */
export function PhotoCell({
  photos,
  fileId,
  onRequestDelete,
  onUpload,
  disabled = false,
  size = "sm",
}: {
  /** この明細に付いている絵 (生きているものだけ。先頭が代表)。 */
  photos: OrderSheetLinePhoto[];
  /** 代表 1 枚 (`fields.PICTURE` の値)。⚠ `photos` が空のときの受け皿。 */
  fileId: string | null;
  /** ゴミ箱。渡さなければボタンを出さない (取り込み中の空の枠など)。 */
  onRequestDelete?: (photo: OrderSheetLinePhoto) => void;
  /**
   * 絵を足す (upload アイコン)。渡さなければボタンを出さない (取り込み中の空の枠など)。
   * ⚠ ボタンが出るのは**絵が 1 枚も無いときだけ**。
   * ⚠ AI がうまく切り出せなかったときに、人が差し替えるための口。
   */
  onUpload?: (file: File) => void;
  disabled?: boolean;
  /**
   * 絵の大きさ。
   *
   * ⚠ `"lg"` は明細のカード用。画面が表から**明細のカード**になり、
   *   Picture がカードの左に大きく出るようになったため。`"sm"` は前と同じ高さ
   *   （ほかの欄と並べるとき用）。⚠ 比率は両方とも保つ（`object-contain`）。
   */
  size?: "sm" | "lg";
}) {
  // ⚠ 高さだけを変える。幅はカード側 (`OrderSheetPanel`) の列が決める。
  const imageClass = size === "lg" ? "max-h-56" : "max-h-24";
  const boxClass = size === "lg" ? "h-56" : "h-24";
  /*
   * ⚠ `photos` が空でも代表があれば 1 枚として出す。**外し方の無い絵**
   *   (`photoId` が無いので `onRequestDelete` も出さない) になるが、
   *   写真の行がまだ無い古いデータでも Picture 欄が空にならない。
   */
  const items: (OrderSheetLinePhoto & { removable: boolean })[] =
    photos.length > 0
      ? photos.map((photo) => ({ ...photo, removable: true }))
      : fileId !== null
        ? [{ photoId: "", fileId, sortKey: 0, removable: false }]
        : [];

  const [index, setIndex] = useState(0);
  // ⚠ 1 枚外すと枚数が減る。添字が末尾を越えたまま残らないように戻す。
  useEffect(() => {
    setIndex((current) => (current < items.length ? current : Math.max(0, items.length - 1)));
  }, [items.length]);

  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  const photo = usePhotoUrl(current?.fileId ?? null);
  const fileInput = useRef<HTMLInputElement>(null);

  /** ⚠ `<label>` の中なので、押しても入力欄へ飛ばさない。 */
  const press = (run: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  };

  /*
   * ⚠⚠ **隠した input は `<body>` に出す (portal)。** `<label>` の中に置くと、`htmlFor` の
   *   無い label は**最初の入力部品**を自分の対象にするので、欄のどこを押しても
   *   ファイルの選択が開いてしまう。portal なら DOM の上で label の外に出る。
   * ⚠ 同じファイルを続けて選べるよう、選んだら値を空に戻す (戻さないと change が来ない)。
   */
  const picker = onUpload
    ? createPortal(
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />,
        document.body,
      )
    : null;

  if (!current) {
    /*
     * ⚠ 足せるときは「未入力」の代わりに upload アイコンだけを出す。
     * ⚠⚠ **upload アイコンを出すのはここ (絵が 1 枚も無いとき) だけ。** 絵があるときは
     *   ゴミ箱の左には置かない。
     *   差し替えたいときは、ゴミ箱で外してから足す。
     */
    if (!onUpload) return <span className="text-xs text-ink-muted">未入力</span>;
    return (
      <span className={`flex ${boxClass} items-center justify-center text-ink-muted`}>
        <button
          type="button"
          aria-label="代表の図を足す"
          title="代表の図を足す"
          className="flex flex-col items-center gap-1 rounded px-3 py-2 text-xs hover:text-ink disabled:opacity-40"
          disabled={disabled}
          onClick={press(() => fileInput.current?.click())}
        >
          <UploadIcon width={20} height={20} />
          <span>画像を選ぶ</span>
        </button>
        {picker}
      </span>
    );
  }

  return (
    <span className="flex flex-col items-center gap-1">
      {photo.isPending ? (
        <span className={`flex ${boxClass} items-center text-xs text-ink-muted`}>読み込み中…</span>
      ) : photo.data ? (
        <img
          src={photo.data}
          alt={items.length > 1 ? `代表の図 ${index + 1} / ${items.length}` : "代表の図"}
          // ⚠ 比率は保つ。高さだけ `size` で変える。
          className={`${imageClass} w-auto object-contain`}
        />
      ) : (
        <span className={`flex ${boxClass} items-center text-xs text-ink-muted`}>
          表示できません
        </span>
      )}

      <span className="flex items-center gap-1 text-[10px] text-ink-muted">
        {/* ⚠ 1 枚しか無いときは送りを出さない (押せないボタンを並べない)。 */}
        {items.length > 1 ? (
          <>
            <button
              type="button"
              aria-label="前の代表の図"
              className="px-1 hover:text-ink disabled:opacity-40"
              disabled={index === 0}
              onClick={press(() => setIndex((current) => Math.max(0, current - 1)))}
            >
              ‹
            </button>
            <span>
              {index + 1}/{items.length}
            </span>
            <button
              type="button"
              aria-label="次の代表の図"
              className="px-1 hover:text-ink disabled:opacity-40"
              disabled={index >= items.length - 1}
              onClick={press(() => setIndex((current) => Math.min(items.length - 1, current + 1)))}
            >
              ›
            </button>
          </>
        ) : null}

        {/*
          ★ この絵を外す。**確認ダイアログは呼ぶ側が出す** (元に戻せない操作)。
          ⚠ ここでは可否を判定しない (`released` かどうかを決めるのは API の 1 か所)。
        */}
        {onRequestDelete && current.removable ? (
          <button
            type="button"
            aria-label="この代表の図を外す"
            title="この代表の図を外す"
            className="px-1 text-danger hover:opacity-80 disabled:opacity-40"
            disabled={disabled}
            onClick={press(() => onRequestDelete(current))}
          >
            <TrashIcon width={12} height={12} />
          </button>
        ) : null}
      </span>
    </span>
  );
}
