import type { RouteObject } from "react-router";

/**
 * UI 側の登録。make gen が集めてルーターに渡す。
 *
 * ⚠⚠ **「発注書分類」の画面は出していない。**
 *   様式ごとの指示文を DB (`ai_prompts` / `partner_form_profiles`) で持つ仕組みをやめ、
 *   **読み取りの指示文は ai の `prompts/` のファイル (git) が正**になったため。
 *   画面を残すと「ここで直せば読み取りが変わる」と誤解させる。
 * ⚠ **ページ・フック・API・DB の表は消していない。** 戻すときは下の 1 件を
 *   `routes` に戻すだけでよい (`pages/FormProfilesPage.tsx` はそのまま動く)。
 *
 *   {
 *     path: "/form-profiles",
 *     handle: { nav: "発注書分類", navOrder: 2, navIcon: "forms" },
 *     lazy: async () => ({ Component: (await import("./pages/FormProfilesPage")).default }),
 *   }
 *
 * ⚠ サイドバーの並びは 案件(1) / ユーザー管理(3) で、2 番目が空いている。
 */
export const routes: RouteObject[] = [];
