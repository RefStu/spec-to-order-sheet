import type { z } from "zod";

export class EnvError extends Error {
  // ⚠ パラメータプロパティ (constructor(readonly x)) は使わない。
  //   Mastra / Node の「型を外すだけ」の実行モードが対応しておらず、起動時に落ちる。
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = "EnvError";
    this.issues = issues;
  }
}

/**
 * 環境変数を zod スキーマで検証して返す。
 *
 * Worker では `c.env`、Node (Mastra) では `process.env` を渡す。
 * 失敗したときは、問題のあるキーをすべて列挙して throw する
 * (1 つずつ直して再起動を繰り返さなくて済むように)。
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, unknown>,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `${key}: ${issue.message}`;
  });
  throw new EnvError(
    [
      "環境変数が不正です。apps/ai/.env.example / apps/web/.dev.vars.example と見比べてください。",
      ...issues.map((line) => `  - ${line}`),
    ].join("\n"),
    issues,
  );
}
