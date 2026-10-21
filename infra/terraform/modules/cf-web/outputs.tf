output "worker_name" {
  value = cloudflare_worker.web.name
}

output "d1_database_id" {
  description = <<-EOT
    wrangler.jsonc の database_id に入れる値。
    ⚠ `id` ではなく `uuid`。`id` は Terraform の内部 ID で、wrangler は受け取らない。
  EOT
  value       = cloudflare_d1_database.db.uuid
}

output "d1_database_name" {
  value = cloudflare_d1_database.db.name
}

output "queue_name" {
  value = cloudflare_queue.jobs.queue_name
}

output "dlq_name" {
  value = cloudflare_queue.dlq.queue_name
}

output "custom_domain" {
  description = "custom domain を作っていれば、その hostname。無ければ空。"
  value       = var.hostname
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.docs.name
}
