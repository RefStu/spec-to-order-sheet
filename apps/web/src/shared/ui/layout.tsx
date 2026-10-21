import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context";
import { LOGIN_PATH } from "../auth/routes";
import { cn } from "./cn";
import { AppIcon, CollapseIcon, ExpandIcon, NAV_ICONS, type NavIconKey } from "./icons";

/**
 * 全画面共通の 3 分割 (サイドバー / ヘッダー / メイン)。
 *
 * ⚠ **どの feature があるかを知らない。** nav は app/client.tsx が
 *   router.gen.tsx の routes から作って渡す。
 * ⚠ **ログイン画面だけサイドバーを出さない**。サインインの状態で出し分ける。
 */
export interface NavItem {
  to: string;
  label: string;
  /**
   * アイコンの**キー**。実体は `shared/ui/icons.tsx` が持つ。
   * ⚠ feature には文字列だけを申告させる (`client.ts` の `handle.navIcon`)。
   *   部品そのものを持たせると、画面の部品が feature 側に散る。
   */
  icon?: NavIconKey;
}

/** たたんだ状態を覚えておく鍵。⚠ localStorage は port ごとに分かれるので、port 違いの環境どうしで混ざらない。 */
const COLLAPSED_KEY = "ui.sidebar.collapsed";

function readCollapsed(): boolean {
  // ⚠ プライベートウィンドウなどで例外が出ることがある。落とさない。
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function Layout({ nav }: { nav: readonly NavItem[] }) {
  const { status, session, signOut } = useAuth();
  const location = useLocation();
  // ⚠ hooks は早期 return より**前**に置く (分岐で数が変わると React が落ちる)。
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // 覚えられなくても画面は動く。
    }
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);
  const onLoginScreen = location.pathname === LOGIN_PATH;

  if (status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center p-8 text-sm text-ink-muted">
        読み込んでいます…
      </div>
    );
  }

  // サインインしていない → ログイン画面だけを枠なしで出す。
  if (status === "signed-out") {
    if (!onLoginScreen) return <Navigate to={LOGIN_PATH} replace />;
    return (
      <main className="flex min-h-full items-center justify-center p-6">
        <Outlet />
      </main>
    );
  }

  if (onLoginScreen) return <Navigate to={nav[0]?.to ?? "/"} replace />;

  const title = nav.find((item) => location.pathname.startsWith(item.to))?.label ?? "";

  return (
    <div className="flex min-h-full">
      <aside
        className={cn(
          "relative flex shrink-0 flex-col border-r border-border bg-surface-muted py-4 transition-[width]",
          collapsed ? "w-16 px-2" : "w-52 px-3",
        )}
      >
        {/*
          ★★ **アプリのアイコンそのものが開閉ボタン**。
            hover したときだけ字形が開閉の印に変わる。縁に浮く丸いボタンは無くした。
          ⚠⚠ **`aria-label` と `aria-expanded` を落とさないこと。** 見た目が
            「アプリのアイコン」なので、**何のボタンかは名前でしか伝わらない**。
          ⚠⚠ **`focus-visible:` の見た目を残すこと。** 無いと**キーボードから開閉できない**
            (フォーカスは当たるのに、どこに居るか見えない)。
          ⚠ `group` は**このボタン**に付ける。サイドバー全体の hover では変えない。
        */}
        <div className={cn("flex items-center gap-2 pb-4", collapsed ? "px-0" : "px-3")}>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "サイドバーをひらく" : "サイドバーをたたむ"}
            aria-expanded={!collapsed}
            className={cn(
              "group relative grid size-[22px] shrink-0 place-items-center rounded-md text-brand",
              "hover:text-ink",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
            )}
          >
            {/*
              ⚠ 字形は**重ねて差し替える** (並べると幅が動いてサイドバーが揺れる)。
              ⚠ `group-focus-visible:` も付ける。キーボードだけでも「開閉できる」と分かるように。
            */}
            <AppIcon
              className="col-start-1 row-start-1 group-hover:opacity-0 group-focus-visible:opacity-0"
              width={22}
              height={22}
            />
            <span className="col-start-1 row-start-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
              {collapsed ? (
                <ExpandIcon width={16} height={16} />
              ) : (
                <CollapseIcon width={16} height={16} />
              )}
            </span>
          </button>
          {!collapsed && <p className="truncate text-sm font-semibold">受発注</p>}
        </div>

        <nav className="flex flex-col gap-1">
          {nav.map((item) => {
            const NavIcon = item.icon ? NAV_ICONS[item.icon] : null;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-md py-2 text-sm font-medium transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    isActive ? "bg-brand text-brand-ink" : "text-ink-muted hover:bg-surface",
                  )
                }
              >
                {NavIcon && <NavIcon className="shrink-0" />}
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-border px-6 py-3">
          <h1 className="flex-1 truncate text-base font-semibold">{title}</h1>
          <span className="truncate text-sm text-ink-muted">{session?.displayName}</span>
          <button
            type="button"
            onClick={signOut}
            className="rounded-md px-2 py-1 text-sm text-ink-muted hover:bg-surface-muted"
          >
            サインアウト
          </button>
        </header>
        <main className="min-w-0 flex-1 px-6 py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
