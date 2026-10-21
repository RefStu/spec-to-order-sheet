# GCP の土台 — API の有効化と、image の置き場所。
#
# ⚠ Artifact Registry は「最初の image push」より先に無ければならず、Cloud Run は
#   image が無いと apply できない。初回は -target でここを先に作る (README.md)。

resource "google_project_service" "this" {
  for_each = toset(var.services)

  project = var.project_id
  service = each.value

  # ⚠ destroy で API を止めない。同じプロジェクトの別のものを巻き添えにする。
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "apps" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "アプリのコンテナ image (apps/ai)。"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.keep_image_count
    }
  }

  depends_on = [google_project_service.this]
}
