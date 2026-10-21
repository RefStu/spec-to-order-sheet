# ============================================================================
# spec-to-order-sheet — 開発の入口
# ============================================================================
# ⚠ **GNU make 3.81 互換で書くこと。** macOS 同梱の make は 3.81 で、devShell の外では
#   それが使われる。使ってはいけないもの: .ONESHELL / $(file ...) / != / .RECIPEPREFIX
# ⚠ **`include .env` はしない。** .env の値をシェル環境に export すると、wrangler などの
#   変数解決 (環境変数 > ファイル) でファイルの値より優先されてしまう。
# ============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

REPO_ROOT := $(shell git rev-parse --show-toplevel 2>/dev/null || pwd)

# make dev の port。⚠ 変えるときは apps/web/.dev.vars の AI_BASE_URL / GOOGLE_TOKEN_URL と
#   apps/ai/.env の PORT も合わせる (ずれると web が gateway に 403 / 502 を受け取る)。
PORT_WEB     ?= 4000
PORT_GATEWAY ?= 4010
PORT_AI      ?= 4011
PORT_PC      ?= 4090
# process-compose に渡すプロセス名 (省略時は全部)。例: make dev P="web gateway"
P            ?=

# ⚠ node / pnpm は devShell にしか無い。devShell の外から呼ばれたときは
#   `nix develop --command` で包んで実行する (direnv を使わないターミナル用)。
ifeq ($(shell command -v pnpm >/dev/null 2>&1 && echo yes),yes)
  RUN :=
else
  RUN := nix develop "$(REPO_ROOT)" --command
endif
PNPM := $(RUN) pnpm --dir "$(REPO_ROOT)"

.PHONY: help install gen gen-check keys db-generate db-migrate dev dev-web \
        lint format typecheck test check infra-validate

help: ## このヘルプを表示
	@echo "spec-to-order-sheet — 使えるコマンド"
	@echo ""
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# 準備
# ---------------------------------------------------------------------------
install: ## 依存をインストールし、登録ファイルを生成
	@$(PNPM) install
	@$(PNPM) run --silent gen

gen: ## features/* から登録ファイル (*.gen.ts) を再生成
	@$(PNPM) run --silent gen

gen-check: ## 登録ファイルが最新か検査
	@$(PNPM) run --silent gen:check

# ⚠ 標準出力には .dev.vars に足す 1 行だけが出る (案内は標準エラー)。
keys: ## gcp-emulator のダミー SA 鍵を作り、.dev.vars に足す 1 行を出す  例: make keys >> apps/web/.dev.vars
	@$(RUN) pnpm --silent --dir "$(REPO_ROOT)/infra/local/gcp-emulator" run keys

# ---------------------------------------------------------------------------
# D1
# ⚠ ローカルの D1 は Miniflare の状態 (apps/web/.wrangler/state) に入る。
#   @cloudflare/vite-plugin も同じ場所を見るので、apps/web で実行する。
# ---------------------------------------------------------------------------
db-generate: ## features/*/db/schema.ts から D1 の migration を作る
	@$(RUN) pnpm --dir "$(REPO_ROOT)/apps/web" exec drizzle-kit generate

# ⚠ stdin を切り離す。端末があると wrangler が「continue? (Y/n)」で入力を待つ。
db-migrate: ## ローカル (Miniflare) の D1 に migration を適用する
	@$(RUN) pnpm --dir "$(REPO_ROOT)/apps/web" exec wrangler d1 migrations apply DB --local </dev/null

# ---------------------------------------------------------------------------
# 起動
# ---------------------------------------------------------------------------
# ⚠⚠ **PORT と HOST は export しない。** process-compose は環境を**すべての**プロセスへ
#   継がせるので、PORT を渡すと apps/ai/.env の PORT を上書きし、mastra dev が gateway と
#   同じ port で起動する。gateway の PORT は process-compose.yml の command の中で渡す。
# ⚠ TUI は端末が無いと落ちるので、端末があるときだけ使う。
dev: ## web / ai / gateway を起動 (web は http://127.0.0.1:4000)  例: make dev P="web gateway"
	@for f in apps/web/.dev.vars apps/ai/.env .local/emulator/emulator-keys.json; do \
	  test -f "$(REPO_ROOT)/$$f" || { echo "[dev][ERROR] $$f がありません。README のセットアップを先に済ませてください。" >&2; exit 2; }; \
	done
	@mkdir -p "$(REPO_ROOT)/.local/logs" "$(REPO_ROOT)/.local/data"
	@cd "$(REPO_ROOT)" && \
	  PORT_WEB=$(PORT_WEB) PORT_GATEWAY=$(PORT_GATEWAY) PORT_AI=$(PORT_AI) \
	  AI_UPSTREAM_URL="http://127.0.0.1:$(PORT_AI)" \
	  TOKEN_URL="http://127.0.0.1:$(PORT_GATEWAY)/token" \
	  EXPECTED_AUDIENCE="http://127.0.0.1:$(PORT_GATEWAY)" \
	  EMULATOR_KEYS_FILE="$(REPO_ROOT)/.local/emulator/emulator-keys.json" \
	  $(RUN) process-compose --config infra/local/process-compose.yml --port $(PORT_PC) \
	    $$([ -t 1 ] && echo -t=true || echo -t=false) up $(P)

dev-web: ## web だけを起動 (ai を使わない画面の確認用)
	@PORT_WEB=$(PORT_WEB) $(RUN) pnpm --dir "$(REPO_ROOT)/apps/web" run dev

# ---------------------------------------------------------------------------
# 品質
# ---------------------------------------------------------------------------
lint: ## ESLint (feature / shared の境界ルールを含む)
	@$(PNPM) run --silent lint

format: ## prettier で整形
	@$(PNPM) run --silent format

typecheck: ## TypeScript の型検査 (root + 全パッケージ)
	@$(PNPM) run --silent typecheck

test: ## vitest
	@$(PNPM) run --silent test

# ⚠ 登録ファイルは make install / make gen が作る。古ければ gen-check が名指しで落とす。
check: gen-check lint typecheck test ## gen-check + lint + typecheck + test
	@echo "check: OK"

# ---------------------------------------------------------------------------
# インフラ
# ---------------------------------------------------------------------------
infra-validate: ## terraform の構文を検査 (資格情報も backend も要らない)
	@$(RUN) terraform -chdir="$(REPO_ROOT)/infra/terraform" init -backend=false -input=false >/dev/null
	@$(RUN) terraform -chdir="$(REPO_ROOT)/infra/terraform" validate
