/**
 * `cloudflare:workers` の型を、**使う分だけ**手で宣言する。
 *
 * ⚠⚠ **なぜ本物の型を読み込まないのか。** 宣言は `@cloudflare/workers-types` の
 *   `index.d.ts` にあるが、あれを tsconfig の `types` に入れると**global が丸ごと入り、
 *   DOM の `Request` / `Response` と衝突する** (apps/web/tsconfig.json のコメント)。
 *   このリポジトリは tsconfig を 1 つに保つため、Workers の型は名前付き import で使う方針。
 *   ところが `cloudflare:workers` は **モジュール**なので名前付き import では引けない。
 *   そこで、実際に使う面だけをここに写す。
 * ⚠ **面を増やすときは本家の宣言に合わせること** (`@cloudflare/workers-types` の
 *   `declare module "cloudflare:workers"`)。ずれると実行時に食い違う。
 */
declare module "cloudflare:workers" {
  import type { ExecutionContext } from "@cloudflare/workers-types";

  /**
   * service binding (RPC) の口の基底クラス。
   * ⚠ `ctx` / `env` は protected。**protected は `keyof` に出ないので RPC 越しには見えない**
   *   (本家のコメントどおり)。だから呼び出し側に漏れない。
   */
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected ctx: ExecutionContext;
    protected env: Env;
    constructor(ctx: ExecutionContext, env: Env);
  }
}
