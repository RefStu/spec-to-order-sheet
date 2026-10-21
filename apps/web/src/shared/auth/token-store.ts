import { DEV_TOKEN_PREFIX } from "./dev-token";

/**
 * サインインの状態の置き場所。
 *
 * ⚠⚠ **cookie を使わない。** ローカルで port 違いの環境を並べると、ホスト名は同じで **port だけ**が違う。
 *   cookie の同一性判定に port は含まれない (RFC 6265) ので、cookie で持つと
 *   全部の環境が 127.0.0.1 の cookie を奪い合う。
 *   localStorage の origin は port を含むので、環境ごとに独立する。
 * ⚠ ID トークンは Authorization: Bearer ヘッダで送る。
 */
const STORAGE_KEY = "spec-to-order-sheet.auth";

/** api-client が 401 を受けたときに投げる。AuthProvider が拾ってログイン画面へ戻す。 */
export const AUTH_SIGNED_OUT_EVENT = "spec-to-order-sheet:signed-out";

export interface StoredSession {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  displayName: string;
  uid: string;
}

/** apiClient の fetch から同期で読めるように、module 変数にも持つ。 */
let current: StoredSession | undefined;

function readStorage(): StoredSession | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : undefined;
  } catch {
    // private window / ストレージ無効。サインアウト状態として扱う。
    return undefined;
  }
}

export function loadSession(): StoredSession | undefined {
  current ??= readStorage();
  return current;
}

export function saveSession(session: StoredSession): void {
  current = session;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 保存できなくても、このタブの間は module 変数で動く。
  }
}

export function clearSession(): void {
  current = undefined;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 何もしない。
  }
}

/** いま送るべき ID トークン。無ければ undefined。 */
export function currentIdToken(): string | undefined {
  return loadSession()?.idToken;
}

export function isDevSession(session: StoredSession | undefined): boolean {
  return Boolean(session?.idToken.startsWith(DEV_TOKEN_PREFIX));
}
