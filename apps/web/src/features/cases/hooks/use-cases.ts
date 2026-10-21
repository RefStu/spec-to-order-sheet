import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiClient, apiFetch } from "../../../shared/api-client";
import { backoffMs, JOB_POLL_MS, LIST_POLL_MS } from "../lib/polling";
import {
  documentListSchema,
  orderSheetSchema,
  reextractResultSchema,
  type Correction,
  type FieldValue,
} from "../lib/order-sheet-contract";

/**
 * ⚠ 自分の feature (cases) の API は hc の RPC 型で叩ける。
 *   ほかの feature の API はまたぐので **素の fetch + zod** で受ける
 *   (lib/order-sheet-contract.ts に形を写してある)。
 */

export function useCases() {
  // ⚠ 何回続けて待ったか。進み具合が止まったら 0 に戻す (次の取り込みをまた細かく追うため)。
  const step = useRef(0);

  return useQuery({
    queryKey: ["cases"] as const,
    queryFn: async () => {
      const res = await apiClient.api.cases.$get();
      if (!res.ok) throw new Error(`発注の一覧を取得できませんでした: ${res.status}`);
      return res.json();
    },
    /*
     * 取り込みが走っている行があれば、進み具合を追う (画面を待たせない)。
     * ⚠ **固定にしない。** 読み取りは分単位かかることがあるので、だんだん伸ばす。
     * ⚠ progress が null の行は追わない — 追うべきジョブが無いという意味 (lib/progress.ts)。
     */
    refetchInterval: (query) => {
      const busy = query.state.data?.some(
        (row) => row.progress === "accepted" || row.progress === "reading",
      );
      if (!busy) {
        step.current = 0;
        return false;
      }
      return backoffMs(step.current++, LIST_POLL_MS);
    },
  });
}

/**
 * ★ ジョブ 1 件を追う。アップロードと「やり直す」の直後に使う。
 *
 * ⚠⚠ **一覧を 3 秒ごとに引かない。** `GET /api/cases` は 5 つの JOIN が走る。
 *   直後に知りたいのは「いま積んだジョブ 1 件」だけなので軽い口を引く。
 * ⚠ 見るのは `progress` (案件の集約) であって `jobStatus` ではない。読み取りジョブ 1 件の
 *   `succeeded` は「ORDER SHEET に書き込んだ」を意味しない (そのあとに生成ジョブが積まれる)。
 * ⚠ 自分の feature の API なので hc の RPC 型で叩ける (zod で受け直す必要が無い)。
 */
export function useJobStatus(jobId: string | undefined) {
  const queryClient = useQueryClient();
  const step = useRef(0);
  // 最後に「終わった」として締めた組。同じ遷移で二度撃たないための覚え書き。
  const settled = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ["case-job", jobId] as const,
    enabled: Boolean(jobId),
    queryFn: async () => {
      const res = await apiClient.api.cases.jobs[":jobId"].$get({ param: { jobId: jobId! } });
      if (!res.ok) throw new Error(`ジョブの状態を取得できませんでした: ${res.status}`);
      return res.json();
    },
    /*
     * ⚠⚠ **ここには副作用を書かない。** このコールバックは observer が間隔を計算し直すたびに
     *   評価されるので、無効化をここに置くと取り直しが多重に走る。締めるのは下の useEffect。
     */
    refetchInterval: (query) => {
      const progress = query.state.data?.progress;
      // 終わった (written / failed) か、追うものが無い (null) なら止める。
      if (progress !== "accepted" && progress !== "reading") {
        step.current = 0;
        return false;
      }
      return backoffMs(step.current++, JOB_POLL_MS);
    },
  });

  const progress = query.data?.progress ?? null;
  const caseId = query.data?.caseId ?? null;

  /*
   * ★ 終わった瞬間に、**その案件の画面が見ているもの 3 つ**を締める。
   *
   * ⚠⚠ **`["cases"]` だけでは足りない。** ORDER SHEET は `["order-sheet", caseId]`、
   *   帳票の一覧は `["case-documents", caseId]` で、**前方一致しないので取り直しが起きない**。
   *   どちらも refetchInterval を持たず staleTime は既定の 30 秒なので、
   *   **リロードするまで古い表が出たままになる**。削除の経路
   *   (`useDeleteDocument`) と同じ 3 点セットに揃えてある。
   * ⚠ **ポーリングは増やさない。** ここは「終わったとき 1 回だけ」で、間隔表 (`JOB_POLL_MS`)
   *   には触らない (`GET /api/cases` は JOIN が 5 本)。
   */
  useEffect(() => {
    if (!jobId || !progress) return;
    if (progress === "accepted" || progress === "reading") {
      // まだ動いている。次に終わったときはもう一度締めたいので、覚え書きを外す。
      settled.current = null;
      return;
    }
    const key = `${jobId}:${progress}`;
    if (settled.current === key) return;
    settled.current = key;

    void queryClient.invalidateQueries({ queryKey: ["cases"] });
    // ⚠ `caseId` は応答に入っている (古いジョブでは null なので、そのときは案件の分を飛ばす)。
    if (caseId) {
      void queryClient.invalidateQueries({ queryKey: ["order-sheet", caseId] });
      void queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
    }
  }, [jobId, progress, caseId, queryClient]);

  return query;
}

export function useCase(caseId: string) {
  return useQuery({
    queryKey: ["cases", caseId] as const,
    queryFn: async () => {
      const res = await apiClient.api.cases[":caseId"].$get({ param: { caseId } });
      if (!res.ok) throw new Error(`発注を取得できませんでした: ${res.status}`);
      return res.json();
    },
  });
}

/** ⚠ ほかの feature (purchase-orders) の API。 */
export function useCaseDocuments(caseId: string) {
  return useQuery({
    queryKey: ["case-documents", caseId] as const,
    queryFn: async () => {
      const res = await apiFetch(
        `/api/purchase-orders/documents?caseId=${encodeURIComponent(caseId)}`,
      );
      if (!res.ok) throw new Error(`帳票の一覧を取得できませんでした: ${res.status}`);
      return documentListSchema.parse(await res.json());
    },
  });
}

/** ★ 案件詳細の核。 */
export function useOrderSheet(caseId: string) {
  return useQuery({
    queryKey: ["order-sheet", caseId] as const,
    queryFn: async () => {
      const res = await apiFetch(`/api/order-sheets/${encodeURIComponent(caseId)}`);
      if (!res.ok) throw new Error(`ORDER SHEET を取得できませんでした: ${res.status}`);
      return orderSheetSchema.parse(await res.json());
    },
  });
}

export interface SaveOrderSheetInput {
  header?: Record<string, FieldValue>;
  /**
   * ⚠ 明細は**セルの番地 → 値**（`"F17"` など）。打ったセルだけを載せる。
   * ⚠ 鍵は **xlsx の絶対番地**（`"F:1"` のような相対の鍵ではない）。
   */
  lines?: { lineId: string; cells: Record<string, FieldValue> }[];
  /*
   * ⚠⚠ **`productionPlan` は消した。** 誰も設定していないまま残っていた。
   *   工程表（`C4:E10`）は**ほかのヘッダと同じ `header` で通す** —
   *   writer は `isHeaderCellRef()` で門番しているだけなので、専用の経路が要らない。
   *   **同じデータに 2 本目の経路を作らないこと。**
   */
  /** ⚠ AI の欄を人が直したときは必ず載せる (正答率の分母になる)。 */
  corrections: Correction[];
}

/** 人が埋める欄の保存。**直接 DB を書かず、必ずこの PATCH を通す。** */
export function useSaveOrderSheet(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveOrderSheetInput) => {
      const res = await apiFetch(`/api/order-sheets/${encodeURIComponent(caseId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`保存できませんでした: ${res.status}`);
      return orderSheetSchema.parse(await res.json());
    },
    onSuccess: (sheet) => {
      queryClient.setQueryData(["order-sheet", caseId], sheet);
      void queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
  });
}

/*
 * ⚠⚠ **承認のフックは外した。**
 *   `POST /api/order-sheets/:caseId/approve` と `approveOrderSheet()` は**残っている**ので、
 *   戻すときはここに `useMutation` を書き直すだけでよい (409 も正常な結果として読むこと)。
 */

/**
 * ★ 原本 PDF を新しいタブで開く。
 *
 * ⚠⚠ **素の `<a href>` では 401 になる。** `/api/files/:fileId/original` は
 *   authMiddleware の内側で、`isPublicApiPath()` は完全一致なのでブラウザの素の遷移には
 *   Authorization が付かない (理由は purchase-orders/api/routes.ts の `originalUrl` の注記)。
 * ⚠ **署名付き URL は作らない。** GIP 以外の認証経路を増やさないため。
 * ⚠ **URL を画面側で組み立てない。** API が返した `originalUrl` をそのまま渡す。
 */
export type OpenOriginalError = "not_found" | "signed_out" | "popup_blocked" | "failed";

/**
 * 画面に出す理由を持つ失敗。`reason` で文面を選ぶ。
 * ⚠ パラメータプロパティ (`constructor(readonly x)`) を使わない。型を外すだけの変換系で落ちる。
 */
export class OpenOriginalFailed extends Error {
  readonly reason: OpenOriginalError;
  readonly status?: number;

  constructor(reason: OpenOriginalError, status?: number) {
    super(reason);
    this.name = "OpenOriginalFailed";
    this.reason = reason;
    this.status = status;
  }
}

export function useOpenOriginal() {
  return useMutation<void, Error, { originalUrl: string }>({
    mutationFn: async ({ originalUrl }) => {
      /*
       * ⚠ **クリック直後に同期でタブを開く。** await のあとに window.open すると
       *   ユーザー操作の文脈が切れていてポップアップブロックに当たる。
       *   中身は後から location で差し替える。
       */
      // ⚠ **"noopener" を付けない。** 付けると window.open は必ず null を返す仕様なので、
      //   あとから location を差し替えられなくなる。開くのは自分の origin の blob なので、
      //   opener が残っても外部に何も渡らない。
      const tab = window.open("", "_blank");
      if (!tab) throw new OpenOriginalFailed("popup_blocked");

      let res: Response;
      try {
        res = await apiFetch(originalUrl);
      } catch (error) {
        tab.close();
        throw error;
      }

      if (!res.ok) {
        tab.close();
        // ⚠ 404 は apiFetch の clearSession() を通らない (401 のときだけ発火する)。
        if (res.status === 404) throw new OpenOriginalFailed("not_found");
        /*
         * ⚠⚠ 401 では apiFetch が既に clearSession() して AUTH_SIGNED_OUT_EVENT を投げている。
         *   **ここで迂回しない。** 認証の振る舞いが 2 通りになると、どちらが本物か分からなくなる。
         *   利用者はこの直後にログイン画面へ移るので、理由だけ伝える。
         */
        if (res.status === 401) throw new OpenOriginalFailed("signed_out");
        throw new OpenOriginalFailed("failed", res.status);
      }

      /*
       * ⚠ 返るのは content-type: application/pdf + content-disposition: inline のストリーム。
       *   blob URL にするとタブがそのまま表示する。
       */
      const url = URL.createObjectURL(await res.blob());
      tab.location.href = url;

      /*
       * ⚠ **revoke を忘れるとリークする。** ただし早すぎるとタブが読み込めない。
       *   読み込み後の revoke は表示を消さない (そのタブの再読み込みだけが失敗する)。
       *   タブが閉じたことは opener からは確実に分からないので、時間で切る。
       */
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });
}

/**
 * 「読み取りをやり直す」。
 * ⚠ 本体 (purchase_orders / revision_requests) は読み取りが成功してから取り込み側が
 *   取り下げる (先には消さない)。前の結果は `ai_extractions.version` を上げて残るので、消えない。
 */
export function useReextract(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ documentId }: { documentId: string }) => {
      const res = await apiFetch(
        `/api/purchase-orders/documents/${encodeURIComponent(documentId)}/reextract`,
        { method: "POST" },
      );
      if (!res.ok) {
        // 404 = その帳票が無い / 409 = 案件を逆引きできない。
        throw new Error(
          res.status === 409
            ? "この帳票は発注に結び付いていないので、やり直せません。"
            : `読み取りをやり直せませんでした: ${res.status}`,
        );
      }
      return reextractResultSchema.parse(await res.json());
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
      void queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
  });
}

/** 発注書をアップロード (案件一覧の入口)。 */
export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, caseId }: { file: File; caseId?: string }) => {
      const form = new FormData();
      form.set("file", file);
      if (caseId) form.set("caseId", caseId);
      const res = await apiFetch("/api/files/uploads", { method: "POST", body: form });
      if (!res.ok) throw new Error(`アップロードに失敗しました: ${res.status}`);
      /*
       * ⚠ 202 は { fileId, caseId, jobId, fileName, status }。
       *   **jobId と caseId を捨てない** — 直後の追跡 (useJobStatus) がこれを使う。
       */
      return (await res.json()) as {
        fileId: string;
        caseId: string;
        jobId: string;
        fileName: string;
        status: string;
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
  });
}

/**
 * ★ 届いた帳票を取り消す。
 *
 * ⚠⚠ **呼ぶ前に必ず確認ダイアログを挟むこと** (元に戻せない操作)。見本は
 *   `components/DeleteDocumentDialog.tsx`。
 * ⚠ 可否の判定は API の 1 か所。画面は 409 の理由を読んで出すだけ。
 */
export function useDeleteDocument(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiFetch(
        `/api/purchase-orders/documents/${encodeURIComponent(documentId)}`,
        { method: "DELETE" },
      );
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          body.error === "released"
            ? "現場に流したあとの発注では、根拠の帳票を取り消せません。"
            : "この帳票は取り消せません。",
        );
      }
      if (!res.ok) throw new Error(`取り消せませんでした: ${res.status}`);
      return (await res.json()) as { ok: true; caseId: string; jobId: string | null };
    },
    onSuccess: () => {
      // 帳票の一覧・ORDER SHEET・案件一覧の通数がまとめて変わる。
      void queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
      void queryClient.invalidateQueries({ queryKey: ["order-sheet", caseId] });
      void queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
  });
}

/**
 * ★ ORDER SHEET を xlsx で落とす。
 *
 * ⚠⚠ **`useOpenOriginal` と同じ罠を踏む。** このパスは認証の内側なので、
 *   素の `<a href>` では 401 の JSON が出る。`apiFetch` で取って blob にする。
 * ⚠ **ファイル名は API が決める** (`content-disposition`)。画面で組み立てると
 *   固有名詞が混ざる (案件の見出しは取引先名から作られている)。
 * ⚠ `revokeObjectURL` を忘れない。
 */
export function useDownloadOrderSheetXlsx(caseId: string) {
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      const res = await apiFetch(`/api/order-sheets/${encodeURIComponent(caseId)}/xlsx`);
      if (res.status === 422) {
        const body = (await res.json().catch(() => ({}))) as { max?: number };
        throw new Error(
          `明細が多すぎて出せません (いまの枠は ${body.max ?? "?"} 行)。雛形を作り直してください。`,
        );
      }
      if (!res.ok) throw new Error(`xlsx を作れませんでした: ${res.status}`);

      const disposition = res.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "ORDER_SHEET.xlsx";
      const url = URL.createObjectURL(await res.blob());

      // ⚠ クリックの直後に始める (ブラウザがユーザー操作と結び付けられなくなる前に)。
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });
}

/**
 * ★ 明細の写真 (`Picture`) を出すための blob URL。
 *
 * ⚠ 欄に入っているのは `files.id` で、画像そのものは
 *   `GET /api/files/:fileId/original` にある。**`<img src>` に直接は書けない**
 *   (`apiFetch` が付ける `Authorization` ヘッダを img タグは送れない)。
 *   `useOpenOriginal` と同じ作法で blob にしてから渡す。
 * ⚠⚠ **キャッシュに載せるのは Blob まで。blob URL は載せない。**
 *   URL を載せると、1 つの絵を見ていた部品が unmount されたときに revoke した URL が
 *   キャッシュに残り、**次に同じ絵を出す部品へ死んだ URL が配られる**
 *   (1 明細に複数枚あると「送って戻すと絵が出ない」という形で必ず出る)。
 *   URL は使う側ごとに `useEffect` で作り、片付けで revoke する。
 * ⚠ 返り値は `{ isPending, data }` の 2 つだけ (画面が使っている形は変えていない)。
 */
export function usePhotoUrl(fileId: string | null): { isPending: boolean; data: string | null } {
  const query = useQuery({
    queryKey: ["file-photo", fileId] as const,
    enabled: fileId !== null,
    // 写真は読み取りをやり直さないと変わらない。取り直しの必要が無い。
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const res = await apiFetch(`/api/files/${fileId}/original`);
      // ⚠ 取れなくても画面は落とさない (欄が空に見えるだけ)。
      if (!res.ok) return null;
      return await res.blob();
    },
  });

  const blob = query.data ?? null;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    // ⚠ **revoke を忘れるとリークする。** 作った本人が片付ける。
    return () => URL.revokeObjectURL(created);
  }, [blob]);

  return {
    // ⚠ URL が入るのは effect のあと。その 1 描画を「表示できません」にしない。
    isPending: query.isPending || (blob !== null && url === null),
    data: url,
  };
}

/**
 * ★ 明細の代表の図を 1 枚だけ外す (画面のゴミ箱)。
 *
 * ⚠⚠ **呼ぶ前に必ず確認ダイアログを挟むこと** (`components/DeletePhotoDialog.tsx`)。
 *   読み取りをやり直しても戻らない。
 * ⚠ 返るのは ORDER SHEET 全体なので、そのまま `setQueryData` で締められる
 *   (取り直しを 1 往復増やさない)。
 * ⚠⚠ **`["file-photo", fileId]` は触らない。** 絵そのものは消えていないし、
 *   同じ絵を別の明細が使っていることがある (1 枚の依頼書が複数の明細に結ばれる)。
 * ⚠ 可否の判定は API の 1 か所。画面は 409 / 404 の理由を出すだけ。
 */
export function useDeleteLinePhoto(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ lineId, photoId }: { lineId: string; photoId: string }) => {
      const res = await apiFetch(
        `/api/order-sheets/${encodeURIComponent(caseId)}/lines/${encodeURIComponent(lineId)}` +
          `/photos/${encodeURIComponent(photoId)}`,
        { method: "DELETE" },
      );
      if (res.status === 409) {
        throw new Error("現場に流したあとの発注では、代表の図を外せません。");
      }
      if (res.status === 404) {
        throw new Error("この代表の図は見つかりませんでした。画面を開き直してください。");
      }
      if (!res.ok) throw new Error(`代表の図を外せませんでした: ${res.status}`);
      return orderSheetSchema.parse(await res.json());
    },
    onSuccess: (sheet) => {
      queryClient.setQueryData(["order-sheet", caseId], sheet);
      // 一覧も引き直す。
      void queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
  });
}

/**
 * ★ 明細に代表の図を 1 枚足す (画面の upload アイコン)。`useDeleteLinePhoto` と対。
 *
 * ⚠ 返るのは ORDER SHEET 全体なので、そのまま `setQueryData` で締められる。
 * ⚠ 受けるのは jpeg / png だけ。判定は API の 1 か所 (中身のバイトで見る)。
 *   画面の `accept` は選びやすくするだけで、守りにはならない。
 */
export function useUploadLinePhoto(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ lineId, file }: { lineId: string; file: File }) => {
      const form = new FormData();
      form.set("file", file);
      const res = await apiFetch(
        `/api/order-sheets/${encodeURIComponent(caseId)}/lines/${encodeURIComponent(lineId)}/photos`,
        { method: "POST", body: form },
      );
      if (res.status === 415) {
        throw new Error("代表の図に使えるのは JPEG か PNG の画像だけです。");
      }
      if (res.status === 409) {
        throw new Error("現場に流したあとの発注では、代表の図を足せません。");
      }
      if (res.status === 404) {
        throw new Error("この明細は見つかりませんでした。画面を開き直してください。");
      }
      if (!res.ok) throw new Error(`代表の図を足せませんでした: ${res.status}`);
      return orderSheetSchema.parse(await res.json());
    },
    onSuccess: (sheet) => {
      queryClient.setQueryData(["order-sheet", caseId], sheet);
      // 一覧も引き直す。
      void queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
  });
}
