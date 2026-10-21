import { createApp } from "../../../shared/hono";

/**
 * /api/auth 配下 (prefix は app/routes.gen.ts が付ける)。
 * ⚠ **メソッドチェーンのまま書くこと。** 途中で変数に代入すると hc の RPC 型が落ちる。
 */
export const routes = createApp()
  /**
   * ブラウザへ GIP の設定を配る。**公開**
   * (shared/auth/routes.ts の PUBLIC_API_PATHS に入れてある)。
   *
   * ⚠ このリポジトリにはブラウザ向けの env の仕組みが無い (.dev.vars は Worker の binding)。
   *   ビルド時に焼き込まず、Worker が c.env から読んで返す。デプロイ先でも再ビルドなしで切り替わる。
   * ⚠ apiKey は Firebase の Web API キーで、**ブラウザに配る前提の公開値**。
   */
  .get("/config", (c) => {
    const projectId = (c.env.GIP_PROJECT_ID ?? "").trim();
    return c.json({
      projectId,
      authDomain: c.env.GIP_AUTH_DOMAIN ?? "",
      apiKey: c.env.GIP_API_KEY ?? "",
      // ⚠ サインインする tenant。Worker の検証 (shared/auth/verify.ts) と同じ値を配る。
      tenantId: (c.env.GIP_TENANT_ID ?? "").trim(),
      // ⚠ 代替サインインが効くのは「GIP が未設定」かつ AUTH_DEV_BYPASS=1 のときだけ。
      //   判定の式は shared/auth/middleware.ts の authenticate() と同じにすること。
      devBypass: !projectId && c.env.AUTH_DEV_BYPASS === "1",
    });
  })
  /** サインイン中の利用者。GIP の email で社内の users 表を引く。 */
  .get("/me", async (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "unauthorized" }, 401);

    // ⚠ users は accounts feature の表。ここは auth feature なので
    //   db/schema.ts を import せず、素の SQL で 1 行だけ引く (境界ルール)。
    const row = await c.env.DB.prepare(
      "SELECT id, name, department, can_approve_order_sheet, is_active FROM users WHERE email = ?1 LIMIT 1",
    )
      .bind(auth.email)
      .first<{
        id: string;
        name: string;
        department: string;
        can_approve_order_sheet: number;
        is_active: number;
      }>();

    return c.json({
      uid: auth.uid,
      email: auth.email,
      via: auth.via,
      // 社内の users に行が無くてもサインインは通す (PoC。名前だけ GIP のものを使う)。
      name: row?.name ?? auth.name,
      department: row?.department ?? null,
      canApproveOrderSheet: Boolean(row?.can_approve_order_sheet),
      isActive: row ? Boolean(row.is_active) : true,
      registered: Boolean(row),
    });
  });
