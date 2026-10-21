import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../../shared/ui/button";
import { EmptyState } from "../../../shared/ui/card";
import { UploadDialog } from "../components/UploadDialog";
import { useCases, useJobStatus, useUploadDocument } from "../hooks/use-cases";
import { ACCEPT_ATTRIBUTE } from "../lib/upload";
import { formatDateTime, orderSheetPresenceLabel } from "../lib/format";

/**
 * 案件一覧。**サインイン後の既定の画面で、PoC の入口。**
 *
 * ⚠ **案件を先に作らせる導線は作らない。** 入口は「帳票が届く」であって「案件を作る」ではない
 *   (案件番号は採番しない。人に案件番号を決めさせない)。
 * ⚠ **画面を待たせない。** アップロードは受け付けたら戻り、進み具合は行に出す。
 */
export default function CaseListPage() {
  const navigate = useNavigate();
  const cases = useCases();
  const upload = useUploadDocument();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [progressText, setProgressText] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  /*
   * ⚠ アップロードが返す jobId を捨てない。一覧 (5 つの JOIN) を 3 秒ごとに引かなくても、
   *   最後に積んだジョブ 1 件を軽く追えば進み具合は分かる。
   *   ⚠ 複数枚まとめて入れたときは**最後の 1 件**を追う。読み取りは並列に走るので、
   *     1 件でも動いていれば案件の集約は reading/accepted を返す (lib/progress.ts)。
   */
  const [trackedJobId, setTrackedJobId] = useState<string | undefined>();
  useJobStatus(trackedJobId);

  /**
   * ★ 選ばれた PDF をまとめて取り込み、**案件詳細へ移る**。
   *
   * ⚠⚠ **1 通目の応答の caseId を 2 通目以降に渡す。** 渡さないと
   *   **1 通ごとに別の案件が起きる** (アップロードは PDF 1 通 = 1 POST)。
   * ⚠ 途中で失敗しても、**そこまでに入った帳票は残る**。案件へ移って続きを見せる。
   */
  async function onSubmit(files: File[]) {
    if (files.length === 0) return;
    let caseId: string | undefined;
    let jobId: string | undefined;
    const names: string[] = [];

    try {
      for (const [index, file] of files.entries()) {
        if (files.length > 1) {
          setProgressText(`${index + 1} / ${files.length} 通目を送っています…`);
        }
        const result = await upload.mutateAsync({ file, caseId });
        caseId ??= result.caseId;
        jobId = result.jobId;
        names.push(result.fileName);
      }
    } catch (error) {
      setNotice(
        `${names.length > 0 ? `${names.join(" / ")} までは受け付けました。` : ""}${
          error instanceof Error ? error.message : "アップロードに失敗しました"
        }`,
      );
    } finally {
      setProgressText(undefined);
      setDialogOpen(false);
    }

    if (!caseId) return;
    setTrackedJobId(jobId);
    // ⚠ 読み取りは裏で走る。**待たずに案件詳細へ移り**、AI の欄を回して見せる。
    //   jobId を渡すのは、移った先で「まだ取り込み中か」をすぐ追えるようにするため。
    void navigate(`/cases/${caseId}`, { state: { jobId } });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-ink-muted">
          発注書・依頼書が届くと発注が起きます。行をクリックすると詳細を開きます。
        </p>
        <Button onClick={() => setDialogOpen(true)} disabled={upload.isPending}>
          {upload.isPending ? "アップロードしています…" : "発注書をアップロード"}
        </Button>
        <UploadDialog
          open={dialogOpen}
          accept={ACCEPT_ATTRIBUTE}
          pending={upload.isPending}
          progressText={progressText}
          onCancel={() => setDialogOpen(false)}
          onSubmit={(files) => void onSubmit(files)}
        />
      </div>

      {notice ? (
        <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      {cases.isPending ? <EmptyState>読み込んでいます…</EmptyState> : null}
      {cases.isError ? (
        <EmptyState>発注の一覧を取得できませんでした。時間をおいて開き直してください。</EmptyState>
      ) : null}

      {cases.data ? (
        cases.data.length === 0 ? (
          <EmptyState>
            まだ発注がありません。『発注書をアップロード』から発注書・依頼書を入れてください。
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <thead className="bg-surface-muted text-left text-ink-muted">
                <tr>
                  {/*
                    ⚠⚠ **「発注No」列は消した。** 見出し (`caseLabel`) が
                      Customer PO を出すようになり、**同じ値が 2 列に並ぶ**ため。
                    ⚠ 取引先は列にしない。CUSTOMER を読み取らない方針なので、
                      いつまでも「(取引先未設定)」にしかならない。
                  */}
                  <th className="px-3 py-2 font-medium">発注</th>
                  <th className="px-3 py-2 font-medium">発注書</th>
                  <th className="px-3 py-2 font-medium">依頼書</th>
                  <th className="px-3 py-2 font-medium">ORDER SHEET</th>
                  <th className="px-3 py-2 font-medium">SHIP</th>
                  <th className="px-3 py-2 font-medium">更新</th>
                </tr>
              </thead>
              <tbody>
                {cases.data.map((row) => (
                  <tr
                    key={row.caseId}
                    onClick={() => void navigate(`/cases/${row.caseId}`)}
                    className="cursor-pointer border-t border-border hover:bg-surface-muted"
                  >
                    {/*
                      ⚠⚠ **進み具合のバッジ (「受け付けた」「読んでいる」「書き込んだ」
                        「失敗した」) は消した。** 一覧では出さない。
                      ⚠ **`row.progress` 自体は消していない。** ポーリングを続けるかの判断が
                        これを見ている (`hooks/use-cases.ts` の `refetchInterval`)。
                        出すのをやめただけ。要約は案件詳細の「取り込み:」の行が持つ。
                    */}
                    <td className="px-3 py-2">
                      <span className="font-medium">{row.caseLabel}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{row.purchaseOrderCount}</td>
                    <td className="px-3 py-2 tabular-nums">{row.revisionRequestCount}</td>
                    <td className="px-3 py-2">{orderSheetPresenceLabel(row.orderSheetStatus)}</td>
                    {/* ⚠ SHIP は営業が決める欄なので、空が正常。空と分かるように出す。 */}
                    <td className="px-3 py-2">
                      {row.shipDate ?? <span className="text-ink-muted">未定</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{formatDateTime(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}
