# spec-to-order-sheet

ジュエリーの受注業務で、**取引先から届く発注書・依頼書の PDF を AI で読み取り、
社内の ORDER SHEET（xlsx）を作るまで**を自動化したアプリです。
RefStu が顧客の PoC として開発したもので、実績の紹介として閲覧用に公開しています。

> [!IMPORTANT]
>
> - **実データ・顧客の書類は含みません。** 画面やテストに出てくる取引先・案件は架空のもの
>   （顧客A / 顧客B など）です。
> - **ライセンスはありません。** All rights reserved. 閲覧目的で公開しています。

## 何を自動化したか

```
発注書・依頼書の PDF
   │  アップロード（案件ごと）
   ▼
① 分類      ページ 1 枚ずつ「発注書 / 依頼書 / その他」を答える
② 読み取り  発注書は 1 回、依頼書は枚数ぶん。互いに独立なので並列に走らせる
③ 図の場所  依頼書の中の製品の図を探し、切り出す
④ 対応づけ  発注書の明細と依頼書を結びつける
   │
   ▼
ORDER SHEET の下書き  →  人が画面で確かめて直す  →  xlsx として出力
```

- 読み取りは Mastra の workflow で、流れ（どのノードを何回呼ぶか）はコードが持ちます。
  進み具合はノードごとに stream で画面に届きます。
- 人が直したところは、直した理由（読み違い・転記先の誤り・単位など）と一緒に記録します。

## 構成

| 部分     | 技術                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| web      | Cloudflare Workers 1 つで React SPA（Vite）と Hono の API を配信。DB は D1（Drizzle）、非同期処理は Queues |
| ai       | Mastra（Cloud Run）。workflow の snapshot と trace は libSQL（ローカルはファイル、クラウドは Turso）       |
| web → ai | Worker が invoker SA の ID token を付けて Cloud Run の IAM を通る。stream はそのまま中継する               |
| ログイン | Google Identity Platform。自己登録は閉じてある（ローカルは代わりのサインイン）                             |
| インフラ | Terraform（Cloud Run / Artifact Registry / D1 / Queues / Worker など）                                     |
| ローカル | nix の devShell でツールの版を固定。Cloud Run の IAM と token endpoint は自作の gcp-emulator で再現        |

```
apps/web/          Cloudflare Worker（React SPA + Hono API）。機能ごとに src/features/<name>/
apps/ai/           Mastra（読み取りの workflow）。src/features/doc-extract/
packages/shared/   env の zod スキーマ、tsconfig、ESLint の設定
infra/local/       ローカルの起動（process-compose）と gcp-emulator
infra/terraform/   クラウドのインフラ
tools/gen/         features/* から登録ファイル（*.gen.ts）を作る
```

## 工夫した点

### 読み取りの精度: ページを画像にして、横帯に割って渡す

PDF をそのままモデルに渡さず、`pdftoppm` でページを画像にし、**そのノードが読むページだけ**を渡しています。
以前は PDF 全体を渡して「n ページ目だけ読んで」と頼んでいましたが、隣のページが見えていたせいで
1 枚目の内容を 2 枚目に写す取り違えが実際に起きました。

細かい印字（資材名や区分の丸印）が読めない問題は、**解像度を上げても直りませんでした**。
200 dpi と 300 dpi で入力トークンがまったく同じで、プロバイダ側が画像を一定の大きさまで縮めていたためです。
効いたのは**ページを横帯に割って拡大した画像を足す**ことで、帯 6 本で丸印まで読めるようになり、
出力トークンが減って時間も縮みました（実測の表は
[`steps/extract.ts`](apps/ai/src/features/doc-extract/steps/extract.ts) の `ZOOM_BANDS`）。
帯を足すときは「同じページの一部を拡大したもので、上から何本目か」を必ず添えています。
言わないと表の行が二重に数えられたり、別の行を読んだりします。

### 読み取りの回数はコードが決める

分類のノードはページ 1 枚ずつの種類だけを答え、何回読むか（発注書 1 回、依頼書は枚数ぶん）は
コード（`lib/group-parts.ts`）が組み立てます。**モデルに数えさせない**ことで、
2 枚を 1 つにまとめて 1 枚を落とすような、誰も気づけない失敗を避けています。
失敗したときも「依頼書 k 枚目（p ページ目）」と名指しで落とします。

### Hono RPC と web ↔ ai の contract で型を落とさない

- web の画面は Hono RPC（`hc<AppType>`）で API を呼び、ルートの型がそのまま画面に届きます。
  feature ごとのルートは自動生成のファイルで連結し、**型が `any` に崩れないこと**をテストで固定しています。
- web は ai の入出力の zod（`contract.ts`）を **`import type` でしか読めない**ようにしてあり
  （ESLint の境界ルールで強制）、パスやモデルの一覧は web 側に書いて `satisfies` で突き合わせます。
  ai 側で変わると web の型検査で落ちます。

### そのほか

- 機能はすべて `features/<name>/` に閉じ、登録ファイルは自動生成（機能を消すときはディレクトリを消すだけ）。
- web と ai は別々に動くが、ローカルでは gcp-emulator が Cloud Run の IAM と Google の token endpoint を
  代わりに受けるので、**web のコードは本番と同じまま**ローカルで ai に繋がります。

## ローカルで動かす

必要なのは [nix](https://nixos.org/download/)（flakes を有効にしたもの）だけです。node / pnpm / process-compose /
poppler（`pdftoppm`）は devShell が用意し、`make` は devShell の外から呼んでも `nix develop` で包んで実行します。
GCP や Cloudflare のアカウントは要りません。読み取りを実際に動かすときだけ OpenAI の API キーが要ります。

```sh
# 1. 依存を入れ、登録ファイル (*.gen.ts) を作る
make install

# 2. 環境変数の例をコピーし、apps/ai/.env の OPENAI_API_KEY に自分のキーを入れる
cp apps/web/.dev.vars.example apps/web/.dev.vars
cp apps/ai/.env.example apps/ai/.env
# ai の保存先 (libSQL のファイル) は絶対パスで書く
echo "LIBSQL_URL='file:$PWD/.local/data/mastra.db'" >> apps/ai/.env

# 3. gcp-emulator のダミー SA 鍵を作り、出てきた 1 行を .dev.vars に足す
make keys >> apps/web/.dev.vars

# 4. ローカルの D1 (Miniflare) にテーブルを作る
make db-migrate

# 5. web / gateway / ai を起動する
make dev
```

| 何                      | URL                                           |
| ----------------------- | --------------------------------------------- |
| 画面（web）             | http://127.0.0.1:4000                         |
| gateway（gcp-emulator） | http://127.0.0.1:4010（`/__emulator/health`） |
| ai（Mastra Studio）     | http://127.0.0.1:4011                         |

画面を開くと代わりのサインインが出ます（`.dev.vars` の `GIP_PROJECT_ID` が空で `AUTH_DEV_BYPASS=1` のときだけ）。
任意のメールアドレスと名前で入れます。

- ダミー SA 鍵は `.local/emulator/` にでき、コミットされません。作り直すときは
  `rm -r .local/emulator` してから手順 3 をやり直し、`.dev.vars` の古い `AI_INVOKER_SA_KEY` の行を消してください。
- `make` だけを打つとコマンドの一覧が出ます。変更したら `make check`（gen-check + lint + typecheck + test）を通します。

## デプロイ

クラウド（Cloudflare + Google Cloud）への出し方は [infra/terraform/README.md](infra/terraform/README.md) にあります。
