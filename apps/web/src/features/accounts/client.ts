import type { RouteObject } from "react-router";

// UI 側の登録。make gen が集めてルーターに渡す。
// ⚠ サイドバーの並びは 案件(1) / 発注書分類(2) / ユーザー管理(3)。
export const routes: RouteObject[] = [
  {
    path: "/accounts",
    handle: { nav: "ユーザー管理", navOrder: 3, navIcon: "users" },
    lazy: async () => ({ Component: (await import("./pages/AccountsPage")).default }),
  },
];
