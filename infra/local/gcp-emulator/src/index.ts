/**
 * gcp-emulator の entry。設定を env から読んで listen するだけ。
 *
 * 単体で動かすとき (make dev を使わないとき) の例:
 *   PORT=4010 AI_UPSTREAM_URL=http://127.0.0.1:4011 \
 *   EMULATOR_KEYS_FILE=$PWD/.local/emulator/emulator-keys.json \
 *   pnpm --dir infra/local/gcp-emulator start
 */
import { serve } from "@hono/node-server";
import { createEmulatorApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createKeyLoader } from "./keys.ts";

const config = loadConfig(process.env);
const app = createEmulatorApp({ config, loadKeys: createKeyLoader(config.keysFile) });

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  // 情報は stderr に出す。
  console.error(`[gateway] http://${config.host}:${info.port} → ${config.aiUpstreamUrl}`);
  console.error(`[gateway] aud=${config.expectedAudience} / token=${config.tokenUrl}`);
  console.error(`[gateway] 鍵: ${config.keysFile}`);
});
