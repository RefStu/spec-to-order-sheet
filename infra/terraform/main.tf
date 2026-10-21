# ⚠⚠ **依存は gcp_base → ai_sa → secrets → ai の一方向。** 並べ替えないこと。
#   secret の器 (と accessor) が Cloud Run より先に無いと、revision が secret_key_ref を
#   解決できずに落ちる。初回の順番は README.md の「3. 初回の apply」。

# API の有効化と Artifact Registry (image の置き場所)。
module "gcp_base" {
  source = "./modules/gcp-base"

  project_id = var.gcp_project_id
  region     = var.region
}

module "ai_sa" {
  source = "./modules/ai-sa"

  project_id = var.gcp_project_id

  depends_on = [module.gcp_base]
}

module "secrets" {
  source = "./modules/secrets"

  project_id = var.gcp_project_id
  names      = toset(concat(values(local.ai_env_secrets), values(local.web_env_secrets)))
  accessors  = local.secret_accessors

  depends_on = [module.gcp_base]
}

module "ai" {
  source = "./modules/ai-service"

  project_id   = var.gcp_project_id
  region       = var.region
  service_name = local.service_ai
  image        = var.ai_image

  runtime_sa_email = module.ai_sa.runtime_sa_email
  invoker_sa_email = module.ai_sa.invoker_sa_email

  env = local.ai_env
  # ⚠ **module.secrets の output から引く** (文字列で組み立て直さない)。
  #   同じ値が出るが、組み立てると依存の辺が消えて器より先に Cloud Run が作られる。
  # ⚠ lookup にしない。名前が欠けたら plan の時点で Invalid index で落ちるほうがよい。
  env_secrets = { for k, name in local.ai_env_secrets : k => module.secrets.secret_paths[name] }

  request_timeout_seconds = local.ai_request_timeout_seconds

  min_instances       = var.ai_min_instances
  max_instances       = var.ai_max_instances
  deletion_protection = var.deletion_protection

  # ⚠ secret_paths は**器**には依存するが、accessor (IAM) には依存しない。
  #   Cloud Run は revision を作るときに runtime SA の権限を見るので、
  #   器と accessor の**両方**がそろってから作らせる。
  depends_on = [module.secrets]
}

module "cf" {
  source = "./modules/cf-web"

  account_id            = var.cloudflare_account_id
  worker_name           = local.worker
  d1_name               = local.d1_name
  queue_name            = local.queue_name
  dlq_name              = local.dlq_name
  r2_bucket_name        = local.r2_bucket_name
  hostname              = var.domain
  zone_id               = var.cloudflare_zone_id
  primary_location_hint = var.d1_location_hint
}
