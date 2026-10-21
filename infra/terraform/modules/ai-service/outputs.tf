output "url" {
  description = <<-EOT
    Cloud Run のサービス URL。
    ⚠ これが Worker の AI_BASE_URL であり、ID token の target_audience でもある。
  EOT
  value       = google_cloud_run_v2_service.ai.uri
}

output "service_name" {
  value = google_cloud_run_v2_service.ai.name
}
