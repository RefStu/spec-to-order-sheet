/**
 * 例外を**人が読める 1 行**にする。
 *
 * ⚠⚠ **`String(e)` にしない。** Mastra が投げるのは Error とは限らず、
 *   プレーンなオブジェクトだと `"[object Object]"` になって**理由が丸ごと消える**。
 *   実際に、読み取りの失敗がすべて `{"error":"[object Object]"}` として web に届いていた。
 * ⚠ **握りつぶさない。** 何も取れなければ JSON にして出す。読めない文字列のほうが、
 *   「原因が分からない」よりましである。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.cause ? `${error.message} (cause: ${describeError(error.cause)})` : error.message;
  }
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    // Mastra / AI SDK は message か error にだけ入れてくることがある。
    for (const key of ["message", "error", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
      if (value !== null && typeof value === "object") return describeError(value);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
