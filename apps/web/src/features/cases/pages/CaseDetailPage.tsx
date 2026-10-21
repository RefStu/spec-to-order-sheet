import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { EmptyState } from "../../../shared/ui/card";
import { DeleteDocumentDialog } from "../components/DeleteDocumentDialog";
import { IngestProgressDialog } from "../components/IngestProgressDialog";
import { DeletePhotoDialog } from "../components/DeletePhotoDialog";
import { OrderSheetPanel } from "../components/OrderSheetPanel";
import {
  OpenOriginalFailed,
  useCase,
  useCaseDocuments,
  useDeleteDocument,
  useDeleteLinePhoto,
  useDownloadOrderSheetXlsx,
  useJobStatus,
  useOpenOriginal,
  useOrderSheet,
  useReextract,
  useSaveOrderSheet,
  useUploadDocument,
  useUploadLinePhoto,
} from "../hooks/use-cases";
import { docKindLabel, openOriginalMessage, progressLabel } from "../lib/format";
import type { DocumentList, OrderSheetLinePhoto } from "../lib/order-sheet-contract";

/**
 * 案件詳細。**PoC の中心。**
 * 上段に概要、その下が『発注書』と『ORDER SHEET』の 2 区画。
 */
export default function CaseDetailPage() {
  const { caseId = "" } = useParams();
  const detail = useCase(caseId);
  const documents = useCaseDocuments(caseId);
  const sheet = useOrderSheet(caseId);
  const save = useSaveOrderSheet(caseId);
  const upload = useUploadDocument();
  const openOriginal = useOpenOriginal();
  const reextract = useReextract(caseId);
  const [documentNotice, setDocumentNotice] = useState<string | undefined>();
  /** 取り消そうとしている帳票 (確認ダイアログを出している間だけ入る)。 */
  const [deleting, setDeleting] = useState<DocumentList["documents"][number] | null>(null);
  const deleteDocument = useDeleteDocument(caseId);
  /**
   * ★ 外そうとしている代表の図 (確認ダイアログを出している間だけ入る)。
   * ⚠ 帳票の取り消し (`deleting`) と同じ作法。**確認を挟まずに撃たない。**
   */
  const [deletingPhoto, setDeletingPhoto] = useState<
    (OrderSheetLinePhoto & { lineId: string; lineNo: number }) | null
  >(null);
  const deleteLinePhoto = useDeleteLinePhoto(caseId);
  const uploadLinePhoto = useUploadLinePhoto(caseId);
  const downloadXlsx = useDownloadOrderSheetXlsx(caseId);
  /*
   * ⚠ アップロードと「やり直す」が返す jobId を捨てない。一覧 (5 つの JOIN) を引かずに、
   *   このジョブ 1 件だけを軽く追う。終わったら useJobStatus が ["cases"] を締める。
   */
  /**
   * ⚠ アップロードから移ってきたときは、その jobId を**引き継いで**追う
   *   (`navigate(..., { state: { jobId } })`)。引き継がないと、移った直後の
   *   「AI が読み取り中」をこの画面が知らず、欄が回らない。
   */
  const handoff = useLocation().state as { jobId?: string } | null;
  const [trackedJobId, setTrackedJobId] = useState<string | undefined>(handoff?.jobId);
  /**
   * ⚠⚠ **画面を離れても読み取りは止まらない** (走っているのはキューの consumer であって
   *   ブラウザではない。実測: タブを閉じた 35 秒後に成功した)。
   *   なので**開き直した画面は、サーバーが知っている「いま走っているジョブ」を拾い直す**。
   *   これが無いと、アップロード / やり直しの直後にしかスピナーが出ない
   *   (再読み込みすると、読み取り中なのに何も出なくなる)。
   * ⚠ `trackedJobId` (この画面で積んだもの) のほうを優先する。積んだ直後は
   *   案件の詳細がまだそのジョブを知らないため。
   */
  const tracked = useJobStatus(trackedJobId ?? detail.data?.ingestingJobId ?? undefined);

  /**
   * ★ まだ取り込み中か。**AI が埋める空欄をスピナーで回す**ための 1 つの判断。
   *
   * ⚠ 案件の進み具合そのものを見る (`accepted` / `reading`)。**欄のキーの一覧は持たない**
   *   (どの欄が AI かは API が `by` で返す)。
   */
  const ingesting = tracked.data?.progress === "accepted" || tracked.data?.progress === "reading";
  /**
   * ★★ 進捗のダイアログを開いているか。
   *
   * ⚠ **読み取りが始まったら自動で開き、人が閉じたら開き直さない。**
   *   閉じたあとも読み取りは続く (走っているのはキューの consumer)。
   * ⚠ 終わったら閉じる。開いたまま「完了」を眺めさせない。
   */
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressDismissed, setProgressDismissed] = useState(false);
  useEffect(() => {
    if (ingesting && !progressDismissed) setProgressOpen(true);
    if (!ingesting) {
      setProgressOpen(false);
      setProgressDismissed(false);
    }
  }, [ingesting, progressDismissed]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/cases" className="text-sm text-ink-muted hover:underline">
          ← 発注一覧へ戻る
        </Link>
      </div>

      {/* 上段 — 案件の概要 */}
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h2 className="text-lg font-semibold">{detail.data?.caseLabel ?? caseId}</h2>
        {/*
          ⚠ **取引先は出さない。** サーバは常に「(取引先未設定)」を返す (`case-service.ts`)。
            CUSTOMER を読み取っていないので**永久に埋まらない**。
          ⚠ 見出し (`caseLabel`) は **Customer PO** を第一に使う
            (`case-service.ts` の `labelOf()`)。一覧も同じ関数なので、両方で同じ名前が出る。
          ⚠ **ORDER SHEET の状態 (「AI が起こした」など) も出さない**。
            状態の値そのものは DB と遷移で使っているので消していない。**表示だけ**外した。
        */}
        <span className="text-sm text-ink-muted">製造番号: {detail.data?.specNo ?? "—"}</span>
      </header>

      {/* 区画 1 — 届いた帳票 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="flex-1 text-sm font-semibold">発注書・依頼書</h2>
          <label className="cursor-pointer text-sm text-ink-muted hover:underline">
            帳票を追加アップロード
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  upload.mutate(
                    { file, caseId },
                    { onSuccess: (result) => setTrackedJobId(result.jobId) },
                  );
                }
                e.target.value = "";
              }}
            />
          </label>
        </div>

        {documentNotice ? (
          <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">
            {documentNotice}
          </p>
        ) : null}

        {/*
          追っているジョブの進み具合。⚠ 見るのは案件の集約であって jobStatus ではない。
          ⚠ 段の内訳はダイアログのほう (`IngestProgressDialog`)。ここは 1 行の要約だけ。
        */}
        {progressLabel(tracked.data?.progress ?? null) ? (
          <p className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">
            <span>取り込み: {progressLabel(tracked.data?.progress ?? null)}</span>
            {ingesting ? (
              <button
                type="button"
                onClick={() => {
                  setProgressDismissed(false);
                  setProgressOpen(true);
                }}
                className="text-xs text-brand underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                進み具合を見る
              </button>
            ) : null}
          </p>
        ) : null}

        {documents.data && documents.data.documents.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {documents.data.documents.map((doc) => (
              <li
                key={doc.documentId}
                className="flex flex-wrap items-center gap-x-4 px-3 py-2 text-sm"
              >
                <span className="font-medium">{docKindLabel(doc.docKind)}</span>
                <span className="text-ink-muted">{doc.formPattern ?? "様式不明"}</span>
                <span className="text-ink-muted">受領 {doc.receivedOn ?? "—"}</span>
                <span className="text-ink-muted">読み取り: {doc.extractionStatus}</span>
                <span className="flex-1" />
                {doc.originalUrl ? (
                  /*
                   * ⚠⚠ **素の <a href> にしない。** このパスは authMiddleware の内側なので
                   *   ブラウザの素の遷移では 401 の JSON が新しいタブに出る。
                   *   apiFetch で取って blob URL で開く (hooks/use-cases.ts の useOpenOriginal)。
                   */
                  <button
                    type="button"
                    className="text-brand hover:underline disabled:opacity-50"
                    disabled={openOriginal.isPending}
                    onClick={() => {
                      setDocumentNotice(undefined);
                      // ⚠ originalUrl は API が返したものをそのまま渡す (画面で組み立てない)。
                      openOriginal.mutate(
                        { originalUrl: doc.originalUrl! },
                        {
                          onError: (error) =>
                            setDocumentNotice(
                              error instanceof OpenOriginalFailed
                                ? openOriginalMessage(error.reason, error.status)
                                : openOriginalMessage("failed"),
                            ),
                        },
                      );
                    }}
                  >
                    原本を開く
                  </button>
                ) : (
                  <span className="text-ink-muted">原本は準備中</span>
                )}

                {/*
                  「読み取りをやり直す」。前の結果は ai_extractions の版として残る。
                  ⚠ 返ってきた jobId をそのまま追跡に渡す (一覧を引き直さない)。
                */}
                <button
                  type="button"
                  className="text-ink-muted hover:underline disabled:opacity-50"
                  disabled={reextract.isPending}
                  onClick={() => {
                    setDocumentNotice(undefined);
                    reextract.mutate(
                      { documentId: doc.documentId },
                      {
                        onSuccess: (result) => setTrackedJobId(result.jobId),
                        onError: (error) => setDocumentNotice(error.message),
                      },
                    );
                  }}
                >
                  読み取りをやり直す
                </button>

                {/*
                  ★ 帳票の取り消し。
                  ⚠⚠ **必ず確認ダイアログを挟む** (元に戻せない操作)。
                     ここでは「消せるかどうか」を判定しない — 判定は API の 1 か所。
                */}
                <button
                  type="button"
                  className="text-danger hover:underline disabled:opacity-50"
                  disabled={deleteDocument.isPending}
                  onClick={() => {
                    setDocumentNotice(undefined);
                    setDeleting(doc);
                  }}
                >
                  取り消す
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>この発注にはまだ帳票が届いていません。</EmptyState>
        )}

        <DeleteDocumentDialog
          document={deleting}
          pending={deleteDocument.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (!deleting) return;
            deleteDocument.mutate(deleting.documentId, {
              onSuccess: (result) => {
                setDeleting(null);
                // 組み直しのジョブをそのまま追う (ORDER SHEET が変わる)。
                if (result.jobId) setTrackedJobId(result.jobId);
                setDocumentNotice("帳票を取り消しました。ORDER SHEET を組み直しています。");
              },
              onError: (error) => {
                setDeleting(null);
                setDocumentNotice(error.message);
              },
            });
          }}
        />
      </section>

      {/* 区画 2 — ORDER SHEET */}
      {sheet.isPending ? <EmptyState>ORDER SHEET を読み込んでいます…</EmptyState> : null}
      {sheet.isError ? (
        <EmptyState>
          ORDER SHEET を取得できませんでした。まだ作られていない可能性があります。
        </EmptyState>
      ) : null}
      {sheet.data ? (
        <OrderSheetPanel
          sheet={sheet.data}
          saving={save.isPending}
          ingesting={ingesting}
          ingestingSince={tracked.data?.ingestingSince ?? null}
          exporting={downloadXlsx.isPending}
          // ⚠ 待てる形で渡す（パネルは成功してから下書きを消し、失敗は理由を出す）。
          onSave={async (input) => {
            await save.mutateAsync(input);
          }}
          onExport={() =>
            downloadXlsx.mutate(undefined, {
              onError: (error) => setDocumentNotice(error.message),
            })
          }
          /*
            ★ 代表の図のゴミ箱。**パネルは mutate しない** (確認を持つこの画面が撃つ)。
            ⚠ 何行目かはここで足す (ダイアログの文面に出す)。
          */
          onRequestDeletePhoto={(photo) =>
            setDeletingPhoto({
              ...photo,
              lineNo: sheet.data?.lines.find((line) => line.lineId === photo.lineId)?.lineNo ?? 0,
            })
          }
          deletingPhoto={deleteLinePhoto.isPending}
          /*
            ★ 代表の図を足す (upload アイコン)。足すのは元に戻せるので確認は挟まない
              (要らなければゴミ箱で外せる)。⚠ 断られた理由は帳票の通知に出す。
          */
          onUploadPhoto={({ lineId, file }) =>
            uploadLinePhoto.mutate(
              { lineId, file },
              { onError: (error) => setDocumentNotice(error.message) },
            )
          }
          uploadingPhoto={uploadLinePhoto.isPending}
        />
      ) : null}

      {/*
        ★ 代表の図を外す前の確認 (元に戻せない)。
        ⚠ **可否の判定はここに書かない。** `released` を断るのは API の 1 か所。
      */}
      <DeletePhotoDialog
        open={deletingPhoto !== null}
        lineNo={deletingPhoto?.lineNo ?? null}
        pending={deleteLinePhoto.isPending}
        onCancel={() => setDeletingPhoto(null)}
        onConfirm={() => {
          if (!deletingPhoto) return;
          deleteLinePhoto.mutate(
            { lineId: deletingPhoto.lineId, photoId: deletingPhoto.photoId },
            {
              onSuccess: () => setDeletingPhoto(null),
              onError: (error) => {
                setDeletingPhoto(null);
                setDocumentNotice(error.message);
              },
            },
          );
        }}
      />

      {/*
        ★★ 読み取りの段。**縦に並べる** (`IngestProgressDialog`)。
        ⚠ 段を組み立てるのは API (`cases/lib/progress.ts` の `stagesOf`)。画面は描くだけ。
      */}
      <IngestProgressDialog
        open={progressOpen}
        stages={tracked.data?.stages ?? []}
        ingestingSince={tracked.data?.ingestingSince ?? null}
        onClose={() => {
          setProgressOpen(false);
          setProgressDismissed(true);
        }}
      />

      {/*
        ⚠⚠ **「残っている不整合」と「承認」はここから外した。**
          - 不整合 … `issues` を**契約ごと**落とした (`order-sheets/schema.ts` と
            `cases/lib/order-sheet-contract.ts` の両方)。⚠ 表 `order_sheet_issues` は残っている。
          - 承認 … **画面だけ**外した。`POST /api/order-sheets/:caseId/approve` と
            `approveOrderSheet()` / `approval.ts` は**そのまま残っている**ので、戻すのは
            この区画と `useApproveOrderSheet` を書き直すだけで済む。
        ⚠⚠ **`released` という状態は消していない。** 承認へ到達する道が無くなったので、
          写真削除の 409 (`order-sheet-writer.ts` の `AlreadyReleased`) と
          帳票削除の 409 (`purchase-orders/services/intake-service.ts`) は
          **死んでいるが無害**な枝になった。**「使われていない」と見て消さないこと。**
      */}
    </div>
  );
}
