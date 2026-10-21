# infra/terraform — デプロイの手順

1 つの環境 (GCP プロジェクト 1 つ + Cloudflare アカウント 1 つ) にデプロイする Terraform の root。

| 置き場所                   | 中身                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `*.tf` (このディレクトリ)  | root。変数は `variables.tf`、雛形は `terraform.tfvars.example`            |
| `modules/gcp-base`         | API の有効化と Artifact Registry (ai の image の置き場所)                 |
| `modules/ai-sa`            | Cloud Run の runtime SA と、Worker が ai を呼ぶための invoker SA          |
| `modules/secrets`          | Secret Manager の**器** (値は入れない)                                    |
| `modules/ai-service`       | apps/ai (Mastra) の Cloud Run                                             |
| `modules/cf-web`           | apps/web の Worker・D1・R2・Queue / DLQ の**器**、任意の custom domain    |
| `gip.tf`                   | 利用者の認証 (Google Identity Platform の設定・tenant・ブラウザ用 API キー) |

構文の確認は資格情報なしでできる (`make infra-validate`、または
`terraform -chdir=infra/terraform init -backend=false && terraform -chdir=infra/terraform validate`)。

## 誰が何を持つか

| もの                                                          | 作る人                                  |
| ------------------------------------------------------------- | --------------------------------------- |
| Cloud Run / SA / secret の**器** / Artifact Registry / GIP    | Terraform                               |
| Worker の**器** / D1 / R2 / Queue / DLQ / custom domain       | Terraform                               |
| Worker の**コード**と設定 (`observability` など)              | `wrangler deploy` (`apps/web/wrangler.jsonc` が設定の正) |
| secret の**値** / invoker SA の**鍵**                         | `gcloud` (Secret Manager) / `wrangler secret put` |
| Turso の DB と token                                          | `turso` CLI (公式の Terraform provider が無い) |
| 利用者                                                        | 手で作る (provider に利用者のリソースが無い) |

⚠ **secret の値と SA の鍵を Terraform に持たせない。** `google_secret_manager_secret_version` や
`google_service_account_key` を使うと、値が tfstate に平文で残る。
Terraform が作るのは器と権限だけで、値はこの手順の中で `gcloud` から入れる。

## 用意するもの

- `terraform` / `gcloud` / `docker` / `turso` / `pnpm` (wrangler は `apps/web` の依存に入っている)
- GCP プロジェクト (課金を有効にしたもの) と、その Owner 相当の権限で
  `gcloud auth login` と `gcloud auth application-default login` を済ませた状態
- Cloudflare のアカウントと API トークン (Workers / D1 / R2 / Queues、custom domain を使うなら
  そのゾーンの DNS と Workers Routes の編集権限)。Terraform も wrangler も環境変数から読む:

  ```sh
  export CLOUDFLARE_API_TOKEN=...
  export CLOUDFLARE_ACCOUNT_ID=...   # wrangler 用
  ```

- [OpenAI の API キー](https://platform.openai.com/api-keys)

以下、コマンドはリポジトリのルートで打つ (`TF="terraform -chdir=infra/terraform"` と置く)。

## 1. Turso の DB を作る

Mastra (apps/ai) の workflow の snapshot と trace の保存先。Terraform では作らない。

```sh
turso db create spec-to-order-sheet --location aws-ap-northeast-1
turso db show spec-to-order-sheet --url      # → terraform.tfvars の turso_url
```

token は手順 3 で secret に入れる。

## 2. 変数を書く

```sh
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
```

`gcp_project_id` / `cloudflare_account_id` / `turso_url` を埋める。`ai_image` は手順 4 まで空でよい。
custom domain を使うときは `domain` と `cloudflare_zone_id` を書く (空なら workers.dev で公開する)。

state は既定でローカル (`infra/terraform/terraform.tfstate`)。複数人で扱うなら
`backend.tf` のコメントにある GCS の backend を使う。

## 3. 初回の apply — 器を先に作り、値を入れる

**初回だけ、secret の器と Artifact Registry を先に作る。** Cloud Run は revision を作るときに
secret (`version = "latest"`) を解決するので、版が 1 つも無い secret を 1 つでもマウントすると
**revision の作成ごと失敗する**。また Cloud Run は image が無いと作れない。
そのため「器を作る → 値と image を入れる → 残りを作る」の順にする。

```sh
$TF init
$TF apply -target=module.gcp_base -target=module.ai_sa -target=module.secrets
```

`-target` の警告 (Applied changes may be incomplete) は想定どおり。

値を入れる (どれも画面やシェルの履歴に残らない形で渡す)。

```sh
P=<gcp_project_id>

# OpenAI の API キー (貼り付けて Enter、Ctrl-D)
gcloud secrets versions add openai-api-key --project=$P --data-file=-

# Turso の token
turso db tokens create spec-to-order-sheet \
  | gcloud secrets versions add turso-token --project=$P --data-file=-

# invoker SA の鍵 (Worker が Cloud Run を呼ぶための ID token を作るのに使う)
# ⚠ 鍵は Terraform では作らない (tfstate に残るため)。作ったらすぐ secret に入れて手元から消す。
gcloud iam service-accounts keys create /tmp/ai-invoker.json \
  --iam-account="$($TF output -raw ai_invoker_sa_email)" --project=$P
gcloud secrets versions add ai-invoker-sa-key --project=$P --data-file=/tmp/ai-invoker.json
rm /tmp/ai-invoker.json
```

組織のポリシーで SA の鍵の作成が禁止されていることがある
(`iam.disableServiceAccountKeyCreation` / `iam.managed.disableServiceAccountKeyCreation`)。
そのときはこのプロジェクトだけ例外にしてもらう。

## 4. ai の image を build して push する

```sh
REPO="$($TF output -raw repository_url)"
gcloud auth configure-docker "${REPO%%/*}"
docker build --platform linux/amd64 -f apps/ai/Dockerfile -t "$REPO/ai:latest" .
docker push "$REPO/ai:latest"
docker inspect --format='{{index .RepoDigests 0}}' "$REPO/ai:latest"
```

最後の行の値 (`...@sha256:...`) を `terraform.tfvars` の `ai_image` に書く。
⚠ **tag ではなく digest で書く。** tag のままだと、押し直しても Terraform が差分を見つけず
revision が更新されない。

## 5. 残りを apply する

```sh
$TF apply
```

⚠ custom domain を設定しているときは、初回はここで custom domain **だけ**が落ちる
(コードが 1 つも deploy されていない Worker には attach できない)。手順 6 のあと、もう一度
`$TF apply` すれば付く。

## 6. Worker を deploy する

`$TF output -raw d1_database_id` の値を `apps/web/wrangler.jsonc` の `database_id` に入れる。
名前 (Worker / D1 / R2 / Queue) は Terraform と同じ文字列なので、ほかは変えなくてよい。

```sh
pnpm --filter @repo/web build
cd apps/web

# D1 の migration
pnpm exec wrangler d1 migrations apply spec-to-order-sheet --remote

# deploy。vars は terraform output の worker_vars をそのまま渡す。
pnpm exec wrangler deploy $(
  terraform -chdir=../../infra/terraform output -json worker_vars \
    | jq -r 'to_entries[] | "--var \(.key):\(.value)"'
)
```

⚠ deploy は必ず `build` の後に行う。build が出した解決済みの設定を wrangler が使う
(`wrangler.jsonc` の `main` のまま deploy すると、vite を通らない別物の Worker になる)。

Worker の secret を入れる (Secret Manager から流し込む)。

```sh
P=<gcp_project_id>
gcloud secrets versions access latest --secret=ai-invoker-sa-key --project=$P \
  | pnpm exec wrangler secret put AI_INVOKER_SA_KEY

# GIP のブラウザ用 API キー (公開値だが、Terraform に値を持たせないため secret で運ぶ)
gcloud services api-keys get-key-string \
  "$(terraform -chdir=../../infra/terraform output -raw gip_api_key_id)" \
  --project=$P --format='value(keyString)' \
  | gcloud secrets versions add gip-api-key --project=$P --data-file=-
gcloud secrets versions access latest --secret=gip-api-key --project=$P \
  | pnpm exec wrangler secret put GIP_API_KEY
```

## 7. 利用者を作る

自己登録は閉じてある (Web API キーはブラウザに配る公開値なので、開けると誰でもアカウントを作れる)。
利用者は管理者が 2 か所に入れる。

1. **GIP の tenant** (`$TF output -raw gip_tenant_id`) にメールとパスワードで作る。
   コンソールの Identity Platform → テナント → ユーザーを追加、または Admin API で:

   ```sh
   P=<gcp_project_id>; T="$($TF output -raw gip_tenant_id)"
   curl -sS -X POST "https://identitytoolkit.googleapis.com/v1/projects/$P/tenants/$T/accounts" \
     -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     -H "x-goog-user-project: $P" -H 'content-type: application/json' \
     -d '{"email":"<email>","password":"<password>","emailVerified":true}'
   ```

2. **D1 の `users`** に同じメールの行を入れる (アプリの中の氏名・社員コード・権限)。

   ```sh
   cd apps/web
   pnpm exec wrangler d1 execute spec-to-order-sheet --remote --command \
     "INSERT INTO users (id, code, name, email, department, site, can_approve_order_sheet, created_at, updated_at)
      VALUES (lower(hex(randomblob(16))), '<code>', '<name>', '<email>', '<department>', '<site>', 0,
              unixepoch() * 1000, unixepoch() * 1000);"
   ```

   `department` は `planning` / `sales` / `production` / `quality` / `admin`、
   `site` は `japan` / `factory` のどれか (`apps/web/src/features/accounts/db/schema.ts`)。

## 2 回目以降

- ai を変えた: 手順 4 → `ai_image` を書き換えて `$TF apply`
- web を変えた: 手順 6 の build と `wrangler deploy` (migration を足したならその前に apply)
- secret を足した: 器は Terraform (`locals.tf` の `ai_env_secrets` / `web_env_secrets`)。
  初回と同じ理由で、`$TF apply -target=module.secrets` → 値を入れる → `$TF apply` の順にする

## ⚠ 守ること

- **`modules/ai-sa` を `modules/ai-service` に戻さない / `locals.tf` の `secret_accessors` に
  `module.ai` を書かない。** 依存が ai → secrets の向きになり、器より先に Cloud Run が作られる。
  `modules/secrets` の `secret_paths` を `var.names` から組み立て直さないのも同じ理由
  (文字列は同じでも依存の辺が消える)。
- **`modules/cf-web` の `lifecycle { ignore_changes = ... }` を消さない。** Worker の設定の正は
  `wrangler.jsonc` で、これが無いと deploy のたびに差分が出て、次の apply が wrangler の設定を巻き戻す。
- **custom domain と一緒に `<hostname>/*` の route も作っている。** ゾーンに `*/*` のような
  ワイルドカードの Worker route があると、custom domain より先にそちらに当たって横取りされるため。
- **ai (Cloud Run) に独自ドメインを付けない。** Worker の `AI_BASE_URL` は ID token の audience
  そのもので、Cloud Run は自分の URL を audience として検証する (403 になる)。
- **`data` source を plan の経路に置かない。** 資格情報なしの validate ができなくなる
  (custom domain のゾーンを ID で受けているのはそのため)。
- **Queue / D1 / R2 / Worker の名前は `apps/web/wrangler.jsonc` と同じ文字列にする**
  (`project_name` を変えたら wrangler.jsonc と `apps/web/src/features/ai-review/queues/consumer.ts` も変える)。
  Queue 名がずれるとデプロイは成功したまま、メッセージが配送されない。
- **GIP の tenant の照合を外さない。** Worker は ID token の `firebase.tenant` を
  `GIP_TENANT_ID` と突き合わせ、この tenant 以外の利用者を落とす。
