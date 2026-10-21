import { useState, type FormEvent } from "react";
import { useAuth } from "../../../shared/auth/auth-context";
import { Button } from "../../../shared/ui/button";
import { Card } from "../../../shared/ui/card";
import { Input } from "../../../shared/ui/input";

/**
 * ログイン画面。
 *
 * ⚠ **失敗したときは「メールアドレスかパスワードが違います」だけを出す。**
 *   どちらが違うかを出すと、そこから当てられる。理由は console にも出さない。
 * ⚠ サイドバーはここだけ出ない (shared/ui/layout.tsx が状態で出し分ける)。
 */
const SIGN_IN_FAILED = "メールアドレスかパスワードが違います";

export default function LoginPage() {
  const { signIn, config } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const devBypass = config?.devBypass ?? false;
  const configured = devBypass || Boolean(config?.apiKey);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const ok = await signIn(email.trim(), password);
      if (!ok) setError(SIGN_IN_FAILED);
    } catch {
      setError(SIGN_IN_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm bg-surface">
      <h1 className="mb-1 text-lg font-semibold">サインイン</h1>
      <p className="mb-5 text-sm text-ink-muted">受発注の画面を使うにはサインインしてください。</p>

      {devBypass ? (
        <p className="mb-4 rounded-md border border-border bg-surface-muted p-3 text-xs text-ink-muted">
          ⚠ ローカルの代替サインインです。GIP を使わず、
          メールアドレスだけで通ります。<strong>ローカル以外では無効です。</strong>
        </p>
      ) : null}

      {!configured ? (
        <p className="mb-4 rounded-md border border-border bg-surface-muted p-3 text-xs text-ink-muted">
          サインインの設定がまだありません。GIP のプロジェクト ID と Web API キーの登録が要ります。
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          メールアドレス
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          パスワード
          <Input
            type="password"
            autoComplete="current-password"
            required={!devBypass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {/* ⚠ 文言はこれ 1 つだけ。どちらが違うかを出さない。 */}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || !configured}>
          {busy ? "サインインしています…" : "サインイン"}
        </Button>
      </form>

      <p className="mt-4 text-xs text-ink-muted">
        パスワードを忘れたときは管理者に連絡してください (PoC では再設定の導線を作っていません)。
      </p>
    </Card>
  );
}
