/**
 * 認証まわりの固定のパス。
 *
 * ⚠ shared は feature を import できないので、ログイン画面のパスは **shared が持ち、
 *   features/auth/client.ts がこれを使う**。逆向き (shared -> feature) を作らないため。
 */
export const LOGIN_PATH = "/login";

/**
 * 認証を通さずに叩けるパス (前方一致ではなく完全一致)。
 *
 * ⚠ **root (app/routes.gen.ts) で弾くので、feature 側のフラグでは間に合わない。**
 *   ここに足すものは「サインインしていない人に見せてよい」ものだけにすること。
 */
export const PUBLIC_API_PATHS: readonly string[] = ["/api/auth/config"];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.includes(pathname);
}
