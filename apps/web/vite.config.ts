import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { runGen } from "../../tools/gen/gen.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
// make dev は 4000 を使う。別の port で動かすときだけ PORT_WEB で上書きする。
const port = Number(process.env.PORT_WEB ?? 4000);

/**
 * features/* を走査して app/*.gen.ts を作り直す。
 * ⚠ runGen は内容が変わったときだけ書くので、HMR が無限に回ることはない。
 */
function featureGen(): Plugin {
  const featuresDir = join(repoRoot, "apps/web/src/features");
  const isEntry = (file: string) =>
    file.startsWith(featuresDir) && /\/(server|client)\.ts$|\/queues\/consumer\.ts$/.test(file);
  return {
    name: "spec-to-order-sheet:feature-gen",
    enforce: "pre",
    buildStart() {
      runGen(repoRoot, { check: false });
    },
    configureServer(server) {
      const regen = (file: string) => {
        if (isEntry(file)) runGen(repoRoot, { check: false });
      };
      server.watcher.on("add", regen);
      server.watcher.on("unlink", regen);
    },
  };
}

export default defineConfig({
  plugins: [featureGen(), react(), tailwindcss(), cloudflare()],
  server: {
    // ⚠ **host を明示する。** 既定では IPv6 の ::1 にしか bind せず、
    //   .dev.vars や README が使う http://127.0.0.1:<port> で繋がらない。
    host: "127.0.0.1",
    port,
    // ⚠ port が埋まっていたら黙ってずらさない。gateway や README の URL とずれるため。
    strictPort: true,
  },
});
