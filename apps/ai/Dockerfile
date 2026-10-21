# =============================================================================
# apps/ai (Mastra) — Cloud Run 用の image
# =============================================================================
# ⚠ **ビルドはリポジトリのルートから行う** (pnpm workspace のため)。
#     docker build -f apps/ai/Dockerfile .
# ⚠ **secret を image に入れない。** .dockerignore で .env* を除外し、さらに
#     MASTRA_SKIP_DOTENV=1 で mastra のビルドにも .env を読ませない。
#     値は Cloud Run が起動時に env として渡す。
# ⚠ node は 22 系に固定する (Mastra は node >= 22.13)。flake.nix の nodejs と合わせること。
# =============================================================================

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 MASTRA_SKIP_DOTENV=1
RUN corepack enable

WORKDIR /repo

# 依存だけ先に入れて、ソースの変更でキャッシュが壊れないようにする。
# ⚠ **pnpm-workspace.yaml に載っているパッケージの package.json は全部 COPY する。**
#    lockfile には importer として入っているので、1 つでも欠けると
#    `pnpm install --frozen-lockfile` が lockfile 不一致で落ちる。
#    pnpm-workspace.yaml にパッケージを足したら、ここにも足すこと。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/ai/package.json apps/ai/
COPY apps/web/package.json apps/web/
COPY infra/local/gcp-emulator/package.json infra/local/gcp-emulator/
RUN pnpm install --frozen-lockfile

COPY . .
# 登録ファイル (*.gen.ts) は gitignore なので、image の中で作り直す (tools/gen)。
RUN pnpm run gen \
  && pnpm --filter @repo/ai build

# -----------------------------------------------------------------------------
# 実行用。mastra build の成果物 (.mastra/output) だけを持ち込む。
# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app

# ⚠⚠ **読み取りはページを画像にしてからモデルに渡す** (src/features/doc-extract/lib/page-images.ts)。
#     スキャンした帳票は PDF のまま渡すと**小さい印字が読めない** (実測: 発注No が null →
#     200 dpi の画像にすると読めた)。その描画に pdftoppm が要る。
#   ⚠ **ネイティブ拡張ではない。** `mastra build` の成果物 (.mastra/output) には
#     node_modules が入らないが、これは OS の二進を subprocess で呼ぶだけなので影響しない。
#   ⚠ ローカル側は flake.nix の poppler-utils。**片方だけ入れると Cloud Run でだけ落ちる。**
#   ⚠ 実行段だけでよい (ビルド中は描画しない)。~70KB + 依存ライブラリ。
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/apps/ai/.mastra/output ./

# ⚠ root では動かさない (node イメージの既定ユーザーを使う)。
USER node
EXPOSE 8080
CMD ["node", "index.mjs"]
