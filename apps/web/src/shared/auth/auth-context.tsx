import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { stringToBase64Url } from "./base64url";
import { DEV_TOKEN_PREFIX } from "./dev-token";
import { refreshIdToken, signInWithPassword } from "./identity-toolkit";
import {
  AUTH_SIGNED_OUT_EVENT,
  clearSession,
  loadSession,
  saveSession,
  type StoredSession,
} from "./token-store";

/**
 * サインインの状態。
 *
 * ⚠ ブラウザ向けの env の仕組みがこのリポジトリには無い (.dev.vars は Worker の binding)。
 *   GIP の設定は **Worker が c.env から読んで返す** GET /api/auth/config から取る。
 *   デプロイ先でも再ビルドなしで切り替えられる。
 */
export interface AuthConfig {
  projectId: string;
  authDomain: string;
  apiKey: string;
  /** GIP tenant。空なら project 直下。 */
  tenantId: string;
  /** ⚠ ローカル専用の代替サインインが効く状態か。 */
  devBypass: boolean;
}

export type AuthStatus = "loading" | "signed-out" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  config?: AuthConfig;
  session?: StoredSession;
  /** 成功なら true。**失敗の理由は返さない** (どちらが違うかを出さないため)。 */
  signIn: (email: string, password: string) => Promise<boolean>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

/** 期限の 2 分前には更新しておく。 */
const REFRESH_MARGIN_SECONDS = 120;

function makeDevSession(email: string): StoredSession {
  const uid = `dev-${email}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = JSON.stringify({ sub: uid, email, name: email.split("@")[0] ?? email, exp });
  // ⚠ btoa は Latin-1 しか受けないので、先に UTF-8 にする (stringToBase64Url)。
  const token = DEV_TOKEN_PREFIX + stringToBase64Url(payload);
  return {
    idToken: token,
    refreshToken: "",
    expiresAt: exp,
    email,
    displayName: email.split("@")[0] ?? email,
    uid,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | undefined>();
  const [session, setSession] = useState<StoredSession | undefined>(() => loadSession());
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/config");
        if (!cancelled && res.ok) setConfig((await res.json()) as AuthConfig);
      } catch {
        // 設定が取れなくても画面は出す (サインインだけができない)。
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(undefined);
  }, []);

  // api-client が 401 を受けたら、ここでサインアウト状態に落とす。
  useEffect(() => {
    const onSignedOut = () => setSession(undefined);
    window.addEventListener(AUTH_SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(AUTH_SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  // ⚠ 期限の少し前に自動更新する。代替サインイン (refreshToken が空) では何もしない。
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!session?.refreshToken || !config?.apiKey) return;

    const delayMs = Math.max(
      5_000,
      (session.expiresAt - REFRESH_MARGIN_SECONDS - Math.floor(Date.now() / 1000)) * 1000,
    );
    timer.current = setTimeout(() => {
      void (async () => {
        const next = await refreshIdToken(config.apiKey, session.refreshToken);
        if (!next) {
          signOut();
          return;
        }
        const updated: StoredSession = { ...session, ...next };
        saveSession(updated);
        setSession(updated);
      })();
    }, delayMs);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [session, config, signOut]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      // ⚠ 代替サインインは「GIP が未設定」のときだけ。API 側も同じ条件で判定する。
      if (config?.devBypass) {
        const next = makeDevSession(email);
        saveSession(next);
        setSession(next);
        return true;
      }
      if (!config?.apiKey) return false;

      const result = await signInWithPassword(config.apiKey, email, password, config.tenantId);
      if (!result) return false;

      const next: StoredSession = {
        idToken: result.idToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        email: result.email,
        displayName: result.displayName,
        uid: result.localId,
      };
      saveSession(next);
      setSession(next);
      return true;
    },
    [config],
  );

  const value = useMemo<AuthState>(
    () => ({
      status: !ready ? "loading" : session ? "signed-in" : "signed-out",
      config,
      session,
      signIn,
      signOut,
    }),
    [ready, session, config, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider の外で useAuth を呼んでいます");
  return value;
}
