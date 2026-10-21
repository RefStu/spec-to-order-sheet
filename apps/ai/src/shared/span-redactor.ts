import type { AnySpan, SpanOutputProcessor } from "@mastra/core/observability";

/**
 * ★★ トレースに載る**巨大な値を目印に置き換える** span の processor。
 *
 * ⚠⚠ **なぜ要るか (実測)。** 1 通の PDF を読む 1 実行で、span は 36 本・合計 7.4MB あった。
 *   中身のほとんどは PDF と画像の base64 で、同じものが何度も載っている:
 *   - `workflow_run.input` … `docExtractRequest`(`dataBase64` 込み) が 131,932 文字
 *   - `agent_run: 依頼書 n 枚目` … モデルに渡した画像 7 枚が 918,915 文字
 *   Langfuse の exporter は span ごとに POST するので、これがそのまま取り込み側の負荷になり、
 *   **トレースが途中までしか出ない**。目印に替えると 1 実行が 100KB 未満になる。
 *
 * ⚠⚠ **画像のキーは `dataBase64` ではない。** Mastra が組み立てるモデルの入力は
 *   `{ type: "file", mediaType: "image/jpeg", data: "data:image/jpeg;base64,/9j/…" }` で、
 *   **キーは `data`、値は data URL**。キー名で判定すると丸ごと取り逃がす。だから
 *   **値の形と長さ**で判定する。
 *
 * ⚠⚠ **元の値を書き換えない (コピーオンライト)。** `span.input` は workflow がまだ使って
 *   いる実体で、`crop-pictures` が `request.dataBase64` を読む。その場で書き換えると
 *   **読み取りごと壊れる**。置き換えが起きた枝だけ新しい器を作り、変わらなかった枝は
 *   元の参照をそのまま返す。
 *   ⚠ span の欄そのものへの代入 (`span.input = …`) は既定の `SensitiveDataFilter` も
 *   同じことをしている。差し替わるのは**欄が指す先**だけで、元の器は無傷。
 *
 * ⚠ 既定の `SensitiveDataFilter` は**この processor の後ろ**に自動で足される
 *   (`Observability` が `[...userProcessors, autoFilter]` にする)。外さないこと。
 */

/** 目印に替える対象を決める閾値。 */
export interface RedactorLimits {
  /**
   * base64 に見える文字列をこの長さ以上で目印に替える。
   * ⚠ 短い base64 (小さな識別子など) は素通しする。
   */
  base64MinChars?: number;
  /**
   * base64 に見えなくても、この長さを超えたら頭だけ残す。
   * ⚠⚠ **32KiB を下げないこと。** 指示文は実測 10,936 文字あり、ここが下がると
   *   「どの指示文で読んだか」がトレースから読めなくなる。
   */
  hardMaxChars?: number;
  /** 歩く深さの上限。⚠ Mastra の直列化は 8 で止まるので、それより深くは見ない。 */
  maxDepth?: number;
}

const DEFAULTS: Required<RedactorLimits> = {
  base64MinChars: 2048,
  hardMaxChars: 32 * 1024,
  maxDepth: 12,
};

/** 循環参照の目印。⚠ `SensitiveDataFilter` と同じ語にしてある (2 つの目印を揃える)。 */
const CIRCULAR = "[Circular Reference]";
const DEPTH_LIMIT = "[depth limit]";

/** data URL の頭を見る範囲。⚠ 5MB の文字列を端から端まで走査しないための上限。 */
const DATA_URL_HEAD = 128;
/** base64 らしさを見る文字数。⚠ 同上。先頭だけで十分に判別できる。 */
const BASE64_SAMPLE = 256;
/** 長すぎる文字列を切ったときに残す頭。何の文字列だったかは分かる長さにする。 */
const KEEP_HEAD = 1000;

/** 人が読める大きさ。 */
function formatBytes(byteLength: number): string {
  if (byteLength >= 1024 * 1024) return `${(byteLength / (1024 * 1024)).toFixed(1)}MB`;
  if (byteLength >= 1024) return `${Math.round(byteLength / 1024)}KB`;
  return `${byteLength}B`;
}

/** `[image/jpeg 1.2MB omitted]` の形の目印を作る。 */
export function omissionMarker(byteLength: number, label: string): string {
  return `[${label} ${formatBytes(byteLength)} omitted]`;
}

/** base64 の文字列が表すバイト数 (詰め物は数えない。目安で十分)。 */
function base64ByteLength(text: string): number {
  return Math.floor((text.length * 3) / 4);
}

/**
 * data URL なら media type を返す。違えば null。
 * ⚠ 先頭 `DATA_URL_HEAD` 文字しか見ない。
 */
export function dataUrlMediaType(text: string): string | null {
  if (!text.startsWith("data:")) return null;
  const at = text.indexOf(";base64,", 0);
  if (at < 0 || at > DATA_URL_HEAD) return null;
  const mediaType = text.slice("data:".length, at);
  return mediaType.length > 0 ? mediaType : "base64";
}

/**
 * base64 に見えるか。**先頭 `BASE64_SAMPLE` 文字だけ**を 1 文字ずつ見る。
 *
 * ⚠⚠ **正規表現を当てないこと。** 数 MB の文字列に当てると全長を走査するうえ、
 *   書き方によってはバックトラックで固まる。ここは観測の経路なので、
 *   **重い処理を持ち込まない**。
 */
export function looksBase64(text: string): boolean {
  const end = Math.min(text.length, BASE64_SAMPLE);
  for (let index = 0; index < end; index++) {
    const code = text.charCodeAt(index);
    const ok =
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      code === 0x2b || // +
      code === 0x2f || // /
      code === 0x3d || // =
      code === 0x2d || // - (base64url)
      code === 0x5f; // _ (base64url)
    if (!ok) return false;
  }
  return end > 0;
}

/** バイト列の器か (Uint8Array / Buffer / ArrayBuffer)。 */
function byteLengthOf(value: object): number | null {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return null;
}

/**
 * 素のオブジェクトか。
 * ⚠ `Date` / `Map` / `Set` / クラスのインスタンスには**入らない**
 *   (器を作り直すと型が変わってしまう)。
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactString(text: string, limits: Required<RedactorLimits>): string {
  const mediaType = dataUrlMediaType(text);
  if (mediaType !== null) {
    // `data:image/jpeg;base64,` のぶんは数えない (目安なので誤差は無視してよい)。
    return omissionMarker(base64ByteLength(text), mediaType);
  }
  if (text.length >= limits.base64MinChars && looksBase64(text)) {
    return omissionMarker(base64ByteLength(text), "base64");
  }
  if (text.length > limits.hardMaxChars) {
    return `${text.slice(0, KEEP_HEAD)}…${omissionMarker(text.length - KEEP_HEAD, "text")}`;
  }
  return text;
}

/**
 * ★ 値を歩いて、巨大なものだけ目印に替える。**元の値は書き換えない。**
 *
 * @returns 置き換えが 1 つも無ければ **`value` と同じ参照**を返す。
 */
export function redactLargePayloads(value: unknown, limits: RedactorLimits = {}): unknown {
  return walk(value, { ...DEFAULTS, ...limits }, new WeakSet<object>(), 0);
}

function walk(
  value: unknown,
  limits: Required<RedactorLimits>,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactString(value, limits);
  if (value === null || typeof value !== "object") return value;

  const bytes = byteLengthOf(value);
  if (bytes !== null) return omissionMarker(bytes, "binary");

  if (depth >= limits.maxDepth) return DEPTH_LIMIT;
  // ⚠ 同じ枝を 2 回通らないためではなく、**輪になっているとき**だけ止める。
  //   だから降りるときに入れて、戻るときに外す (同じ器を 2 か所から指すのは輪ではない)。
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const replaced = walk(item, limits, seen, depth + 1);
        if (replaced !== item) changed = true;
        return replaced;
      });
      return changed ? next : value;
    }

    if (!isPlainObject(value)) return value;

    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const replaced = walk(item, limits, seen, depth + 1);
      if (replaced !== item) changed = true;
      next[key] = replaced;
    }
    return changed ? next : value;
  } finally {
    seen.delete(value);
  }
}

/** 歩く span の欄。⚠ `errorInfo` / `requestContext` は実測で大きくならないので触らない。 */
const REDACTED_FIELDS = ["input", "output", "attributes", "metadata"] as const;

export class LargePayloadRedactor implements SpanOutputProcessor {
  name = "large-payload-redactor";

  // ⚠ パラメータプロパティ (`constructor(private readonly x)`) を使わない
  //   (Mastra の実行時は型を外すだけなので起動時に落ちる)。
  private readonly limits: Required<RedactorLimits>;

  constructor(limits: RedactorLimits = {}) {
    this.limits = { ...DEFAULTS, ...limits };
  }

  process(span?: AnySpan): AnySpan | undefined {
    if (!span) return span;
    // ⚠ 欄ごとに書き換える。型は span の種類ごとに違うので、ここだけ器として扱う。
    const fields = span as unknown as Record<string, unknown>;
    for (const field of REDACTED_FIELDS) {
      try {
        fields[field] = redactLargePayloads(fields[field], this.limits);
      } catch {
        /*
         * ⚠⚠ **欄ごとに握りつぶす。** 呼ぶ側 (`processSpan`) も try/catch しているが、
         *   あちらで捕まると「**編集前の巨大な span がそのまま export される**」。
         *   ここで握れば、壊れた欄以外は小さくなる。
         */
      }
    }
    return span;
  }

  async shutdown(): Promise<void> {
    // 持っている状態が無いので何もしない。
  }
}
