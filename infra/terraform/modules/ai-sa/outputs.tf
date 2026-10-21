output "runtime_sa_email" {
  description = "Cloud Run が secret を読むときの主体。secrets モジュールの accessors に渡す。"
  value       = google_service_account.runtime.email
}

output "invoker_sa_email" {
  description = "Worker が使う SA。鍵は gcloud で作る (Terraform では作らない)。"
  value       = google_service_account.invoker.email
}
