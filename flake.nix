{
  description = "spec-to-order-sheet — Hono (Cloudflare Workers) × Mastra (Cloud Run) 開発用の CLI 一式 (macOS / Linux)";

  # ============================================================================
  # ⚠ このファイルは **ツールのバージョンの正**。版は flake.lock で固定する。
  #
  # 設計の前提:
  #   - Worker は @cloudflare/vite-plugin (workerd) で、Mastra は `mastra dev` で
  #     ホスト上の node が動かす。wrangler / mastra は pnpm の devDependencies で入れる
  #     (ここに入れると package.json とバージョンが二重管理になる)。
  # ============================================================================

  inputs = {
    # 再現性は flake.lock で担保する。unstable にしているのは wrangler /
    # process-compose の更新が速く、安定チャンネルだと古い版に固定されるため。
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          # ⚠ terraform は BSL ライセンスで nixpkgs では unfree 扱い。
          #   allowUnfree = true にすると他の unfree も黙って入るので、terraform だけを許可する。
          config.allowUnfreePredicate = pkg: builtins.elem (nixpkgs.lib.getName pkg) [ "terraform" ];
        };
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            name = "spec-to-order-sheet";

            packages = [
              # --- ビルドツール ---------------------------------------------------
              # ⚠ macOS 同梱の make は 3.81。ここで新しいものを入れるが、
              #   **Makefile 自体は 3.81 互換に保つこと** (devShell の外でも動かすため)。
              #   .ONESHELL / $(file ...) / != / .RECIPEPREFIX は使わない。
              pkgs.gnumake

              # ⚠ **git を明示的に入れる。** macOS の /usr/bin/git は xcrun の shim で、
              #   devShell の中では xcrun が nixpkgs のスタブに解決されて
              #   `error: tool 'git' not found` で落ちる。
              pkgs.git

              # --- 言語ランタイム -------------------------------------------------
              # ⚠ Mastra は node >= 22.13 を要求する。apps/ai/Dockerfile の node と合わせること。
              pkgs.nodejs_22
              pkgs.pnpm

              # --- インフラ (infra/terraform のデプロイ手順が使う) -------------------
              pkgs.terraform
              # ⚠ nixpkgs の google-cloud-sdk は読み取り専用のストアに入るため
              #   `gcloud components install` が動かない。追加コンポーネントが要るときは
              #   `(google-cloud-sdk.withExtraComponents [ ... ])` に書き換えること。
              pkgs.google-cloud-sdk

              # --- ローカル開発 ---------------------------------------------------
              pkgs.process-compose

              # ⚠⚠ **読み取りが実行時に使う** (開発機だけのツールではない)。
              #   apps/ai はページを pdftoppm で画像にしてからモデルに渡す
              #   (apps/ai/src/features/doc-extract/lib/page-images.ts)。
              #   スキャンした帳票は PDF のまま渡すと小さい印字が読めないため。
              #   ⚠ **Cloud Run にも同じ二進が要る。** apps/ai/Dockerfile の実行段で
              #   `apt-get install poppler-utils` している。**片方だけ直さないこと。**
              pkgs.poppler-utils
            ];

            shellHook = ''
              # ⚠⚠ **shellHook の出力は必ず stderr へ出すこと (>&2)。**
              #   stdout に出すと `V=$(nix develop --command ...)` のコマンド置換に混ざり、
              #   JSON のパースなどが壊れる。
              echo "devShell — node $(node -v) / pnpm $(pnpm -v)。'make' でコマンド一覧。" >&2
            '';
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
