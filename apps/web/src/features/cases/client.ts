import type { RouteObject } from "react-router";

// UI 側の登録。make gen が集めてルーターに渡す。
// ⚠ handle.nav はサイドバーの見出し、navOrder はその並び順 (app/client.tsx が読む)。
//   サイドバーは『案件 / 発注書分類 / ユーザー管理』の順。
export const routes: RouteObject[] = [
  {
    path: "/cases",
    handle: { nav: "発注", navOrder: 1, navIcon: "cases" },
    lazy: async () => ({ Component: (await import("./pages/CaseListPage")).default }),
  },
  {
    // ⚠ 案件詳細は一覧から入る。サイドバーには出さない (nav を書かない)。
    path: "/cases/:caseId",
    lazy: async () => ({ Component: (await import("./pages/CaseDetailPage")).default }),
  },
];
