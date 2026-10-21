import { SpanType } from "@mastra/core/observability";
import { LangfuseExporter } from "@mastra/langfuse";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import type { AiEnv } from "@repo/shared/env";
import { LargePayloadRedactor } from "./span-redactor";

type ObservabilityEnv = Pick<
  AiEnv,
  "LANGFUSE_BASE_URL" | "LANGFUSE_PUBLIC_KEY" | "LANGFUSE_SECRET_KEY" | "LANGFUSE_ENVIRONMENT"
>;

/**
 * ★ 1 回のバッチに入れる span の数と、待つ秒数。
 *
 * ⚠⚠ **`realtime: true` にしないこと。** あれは `exportMode: "immediate"` で、
 *   **span 1 本ごとに 1 回 POST する**。1 実行で 20 本ほどの span が出るので、
 *   Langfuse の worker と ClickHouse を 1 実行で 20 回叩くことになり、
 *   取り込みが追いつかずに**トレースが途中までしか出ない**。
 * ⚠ 読み取りは 1 通で 250 秒ほどかかるので、5 秒遅れて画面に出ても支障は無い。
 */
const LANGFUSE_FLUSH_AT = 32;
const LANGFUSE_FLUSH_INTERVAL_SECONDS = 5;

/** ⚠ 目印を取り逃がしたときの最後の堰 (既定は 128KiB)。指示文 (実測 10,936 文字) は残る。 */
const MAX_STRING_LENGTH = 32 * 1024;

/** 有効にする exporter。Studio 用は常に、自前の Langfuse へは LANGFUSE_BASE_URL があるときだけ送る。 */
export function createExporters(env: ObservabilityEnv) {
  const exporters: Array<MastraStorageExporter | LangfuseExporter> = [new MastraStorageExporter()];
  if (env.LANGFUSE_BASE_URL) {
    exporters.push(
      new LangfuseExporter({
        baseUrl: env.LANGFUSE_BASE_URL,
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        // 同じ Langfuse の project の中で、実行環境を environment で分ける。
        environment: env.LANGFUSE_ENVIRONMENT,
        // ⚠ バッチで送る (理由は上の注記)。
        realtime: false,
        flushAt: LANGFUSE_FLUSH_AT,
        flushInterval: LANGFUSE_FLUSH_INTERVAL_SECONDS,
      }),
    );
  }
  return exporters;
}

/**
 * ★ 観測の設定そのもの。**`Observability` を組み立てずに中身を確かめられるように**
 *   関数として出してある (テストはここを見る)。
 */
export function createTracingConfig(env: ObservabilityEnv) {
  return {
    serviceName: "ai",
    exporters: createExporters(env),
    /*
     * ★★ **巨大な base64 を目印に替えてから送る** (`shared/span-redactor.ts`)。
     *   実測で 1 実行 7.4MB / 36 span あり、中身のほとんどが PDF と画像だった。
     * ⚠ 既定の `SensitiveDataFilter` は**この後ろ**に自動で足される。外さないこと
     *   (`sensitiveDataFilter: false` を書かない)。
     */
    spanOutputProcessors: [new LargePayloadRedactor()],
    /*
     * ⚠⚠ **model_chunk は送らない。** 実測で 1 実行 36 span のうち **16 本**がこれで、
     *   中身は 1〜1,447 文字の断片。この workflow は stream していないので読む価値が無く、
     *   span の数だけが 4 割増えていた。
     * ⚠ `MODEL_STEP` / `MODEL_GENERATION` は**外さない**
     *   (1 回のモデル呼び出しの中で何が起きたかが消える)。
     */
    excludeSpanTypes: [SpanType.MODEL_CHUNK],
    serializationOptions: { maxStringLength: MAX_STRING_LENGTH },
  };
}

export function createObservability(env: ObservabilityEnv): Observability {
  return new Observability({ configs: { default: createTracingConfig(env) } });
}
