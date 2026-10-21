# apps/web (Cloudflare Worker) が使うリソースの **器**。
#
# ⚠⚠ **Terraform は「存在」の正、wrangler.jsonc は「設定」の正。**
#   wrangler deploy は version を上げるだけでなく、Worker 本体の設定
#   (observability / logpush / tags / tail_consumers) も wrangler.jsonc の内容で
#   上書きする。ignore_changes を付けないと、deploy のたびに plan が差分を出し、
#   次の apply が wrangler の設定を巻き戻す。
#   **ここの ignore_changes を「不要な記述」と見て消さないこと。**
#
# ⚠ 器を Terraform が持つ理由は 1 つ: cloudflare_workers_custom_domain は Worker が
#   存在しないと attach できない。wrangler に Worker の作成を任せると初回 apply が必ず落ちる。

resource "cloudflare_worker" "web" {
  account_id = var.account_id
  name       = var.worker_name

  # wrangler.jsonc の observability.enabled と同じ初期値にしておく。
  observability = {
    enabled = true
  }

  lifecycle {
    ignore_changes = [observability, logpush, subdomain, tags, tail_consumers]
  }
}

resource "cloudflare_d1_database" "db" {
  account_id            = var.account_id
  name                  = var.d1_name
  primary_location_hint = var.primary_location_hint

  # ⚠ 書かないと、Cloudflare が作成時に入れる既定値 (disabled) を「消す」差分が
  #   apply のたびに出る。
  read_replication = {
    mode = "disabled"
  }
}

# 発注書・依頼書の PDF の実体。D1 には参照 (files.storage_key) だけを持つ。
# ⚠ 名前は wrangler.jsonc の r2_buckets[].bucket_name と同じにする。
resource "cloudflare_r2_bucket" "docs" {
  account_id = var.account_id
  name       = var.r2_bucket_name
}

# ⚠ **Queue 名は 4 か所で一致していないと配送されない。**
#   ここ / wrangler.jsonc の producers[].queue / consumers[].queue /
#   apps/web/src/features/ai-review/queues/consumer.ts の consumer.queue。
#   ずれてもデプロイは成功し、メッセージが届かない (DLQ に落ちる) だけなので気付きにくい。
#
# ⚠ **producers / consumers に ignore_changes は要らない** (書くと terraform validate が
#   「redundant」と警告する)。この 2 つは provider が読み取るだけの属性なので、
#   wrangler が登録した consumer を Terraform が剥がすことはない。
#   consumer の設定 (max_batch_size / max_retries / dead_letter_queue) の正は
#   wrangler.jsonc 側にある (Miniflare のローカル配送もそれを見る)。
resource "cloudflare_queue" "jobs" {
  account_id = var.account_id
  queue_name = var.queue_name
}

resource "cloudflare_queue" "dlq" {
  account_id = var.account_id
  queue_name = var.dlq_name
}

# ⚠ hostname が空なら作らない (workers.dev の URL で公開する)。
# ⚠ Worker にコードが 1 つも deploy されていないと attach できない
#   (「Worker … has no deployments」)。初回は wrangler deploy の後にもう一度 apply する。
resource "cloudflare_workers_custom_domain" "web" {
  count = var.hostname == "" ? 0 : 1

  account_id = var.account_id
  hostname   = var.hostname
  service    = cloudflare_worker.web.name
  zone_id    = var.zone_id
}

# ⚠⚠ **custom domain だけでは届かないことがある。** ゾーンに `*/*` のような
#   ワイルドカードの Worker route があると、custom domain より route が先に当たり、
#   リクエストはその Worker に横取りされる。より細かいパターンの route が優先されるので、
#   自分の hostname の route を明示して取り返す。custom domain は DNS と証明書のために残す。
# ⚠ route は Worker にコードが無くても作れる (custom domain と違って deployment を要求しない)。
resource "cloudflare_workers_route" "web" {
  count = var.hostname == "" ? 0 : 1

  zone_id = var.zone_id
  pattern = "${var.hostname}/*"
  script  = cloudflare_worker.web.name
}
