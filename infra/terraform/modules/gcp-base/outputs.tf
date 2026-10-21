output "repository_url" {
  description = "docker push の宛先 (<region>-docker.pkg.dev/<project>/<repo>)。"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.apps.repository_id}"
}

output "enabled_services" {
  description = "有効にした API。"
  value       = sort([for s in google_project_service.this : s.service])
}
