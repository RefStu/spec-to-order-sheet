import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { queryClient } from "../shared/api-client";
import { AuthProvider } from "../shared/auth/auth-context";
import { isNavIconKey } from "../shared/ui/icons";
import { Layout, type NavItem } from "../shared/ui/layout";
import "../shared/ui/styles.css";
import { featureRoutes } from "./router.gen";

/**
 * SPA の entry。
 *
 * ⚠ **ここに feature を書かない。** ルートは router.gen.tsx (`make gen` が生成) から読む。
 * ⚠ ナビゲーションの見出しは各 feature が `handle: { nav: "…", navOrder: n }` で申告する。
 *   entry が feature の名前を持たないようにするため。
 * ⚠ **サイドバーに出すのは navOrder を申告した route だけ。** 画面の数を
 *   絞るため。route はあってもサイドバーに出さない画面がある (直接の URL では開ける)。
 */
interface NavHandle {
  nav?: string;
  navOrder?: number;
  /** アイコンの**キー**だけを申告させる (実体は shared/ui/icons.tsx)。 */
  navIcon?: string;
}

const nav: NavItem[] = featureRoutes
  .flatMap((route: RouteObject) => {
    const handle = route.handle as NavHandle | undefined;
    if (!handle?.nav || typeof handle.navOrder !== "number" || !route.path) return [];
    return [
      {
        to: route.path,
        label: handle.nav,
        order: handle.navOrder,
        // ⚠ 知らないキーは黙って落とす (feature 側の綴り間違いで画面を壊さない)。
        icon: isNavIconKey(handle.navIcon) ? handle.navIcon : undefined,
      },
    ];
  })
  .sort((a, b) => a.order - b.order)
  .map(({ to, label, icon }) => ({ to, label, icon }));

const router = createBrowserRouter([
  {
    path: "/",
    element: (
      <AuthProvider>
        <Layout nav={nav} />
      </AuthProvider>
    ),
    children: [
      ...(nav[0] ? [{ index: true, element: <Navigate to={nav[0].to} replace /> }] : []),
      ...featureRoutes,
    ],
  },
]);

const container = document.getElementById("root");
if (!container) throw new Error("#root がありません (index.html を確認してください)");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
