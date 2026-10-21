output "repository_url" {
  description = "docker push の宛先 (<region>-docker.pkg.dev/<project>/<repo>)。"
  value       = module.gcp_base.repository_url
}

output "ai_url" {
  description = "Cloud Run の URL。Worker の AI_BASE_URL であり、ID token の audience でもある。"
  value       = module.ai.url
}

output "ai_service_name" {
  value = module.ai.service_name
}

output "ai_invoker_sa_email" {
  description = "Worker が ai を呼ぶための SA。鍵は gcloud で作る (Terraform では作らない)。"
  value       = module.ai_sa.invoker_sa_email
}

output "ai_runtime_sa_email" {
  value = module.ai_sa.runtime_sa_email
}

output "secret_names" {
  description = "値を入れる secret の器 (環境変数名 → secret 名)。"
  value       = merge(local.ai_env_secrets, local.web_env_secrets)
}

output "gip_tenant_id" {
  description = "利用者を置く GIP tenant の ID。Worker の GIP_TENANT_ID。"
  value       = google_identity_platform_tenant.users.name
}

output "gip_api_key_id" {
  description = <<-EOT
    API キーの uid。値そのものは出さない (tfstate に残さないため)。値は次で取り出す:
      gcloud services api-keys get-key-string <この値> --project=<PROJECT_ID>
  EOT
  value       = google_apikeys_key.gip_web.uid
}

output "worker_vars" {
  description = "Worker に渡す vars (wrangler deploy の --var)。secret は含まない。"
  value = {
    AI_BASE_URL      = module.ai.url
    GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
    GIP_PROJECT_ID   = var.gcp_project_id
    GIP_TENANT_ID    = google_identity_platform_tenant.users.name
    GIP_AUTH_DOMAIN  = "${var.gcp_project_id}.firebaseapp.com"
  }
}

output "worker_name" {
  value = module.cf.worker_name
}

output "d1_database_id" {
  description = "apps/web/wrangler.jsonc の database_id に入れる値。"
  value       = module.cf.d1_database_id
}

output "d1_database_name" {
  value = module.cf.d1_database_name
}

output "queue_name" {
  value = module.cf.queue_name
}

output "dlq_name" {
  value = module.cf.dlq_name
}

output "r2_bucket_name" {
  value = module.cf.r2_bucket_name
}

output "custom_domain" {
  description = "custom domain を作っていれば、その hostname。無ければ空 (workers.dev で公開)。"
  value       = module.cf.custom_domain
}
