import type { RouteObject } from "react-router";
import { LOGIN_PATH } from "../../shared/auth/routes";

// UI 側の登録。make gen が集めてルーターに渡す。
// ⚠ **handle.nav / navOrder を書かない。** ログイン画面はサイドバーに出さない。
export const routes: RouteObject[] = [
  {
    path: LOGIN_PATH,
    lazy: async () => ({ Component: (await import("./pages/LoginPage")).default }),
  },
];
