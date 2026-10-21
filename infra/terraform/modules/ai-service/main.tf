# apps/ai (Mastra) を Cloud Run で動かす。
#
# ⚠ **アプリ自身は認証をしない。** Cloud Run IAM が唯一の関門なので、
#   allUsers に run.invoker を与えないこと (ローカルでは gcp-emulator が同じ役をする)。
# ⚠ **ai に独自ドメインを付けない。** AI_BASE_URL は ID token の target_audience
#   そのもので、Cloud Run は自分の .uri を aud として検証する (403 になる)。
# ⚠⚠ **SA はこのモジュールでは作らない** (modules/ai-sa の担当)。email を受け取るだけ。
#   ここで作ると secrets の accessors が module.ai を参照することになり、依存が
#   ai → secrets の向きになって **器より先に Cloud Run が作られる**。理由は modules/ai-sa。

resource "google_cloud_run_v2_service" "ai" {
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  deletion_protection = var.deletion_protection

  # ⚠ Cloudflare Worker (= インターネット) から呼ばれるので ALL。
  #   「非公開」は allUsers に invoker を与えないことで担保する。
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = var.runtime_sa_email

    # ⚠⚠ **短いほうで切れる。** 読み取り 1 通は「分類 + 発注書 + 依頼書の枚数ぶん」で
    #   分単位かかる。Cloud Run の既定は 300 秒なので、アプリ側 (AI_REQUEST_TIMEOUT_MS) を
    #   延ばしてもここが短いままだと **ai が仕事を終えていても 504 で捨てられる**。
    #   値はアプリ側と同じ変数から導く (root の locals.tf)。
    timeout = "${var.request_timeout_seconds}s"

    # ⚠⚠ **1 リクエストの中で並列にモデルを呼ぶ** (発注書と依頼書は独立)。効くのは
    #   同時実行数ではなく **1 インスタンスの CPU** なので、同時に受ける数を絞って
    #   CPU を厚くする。ページの描画 (pdftoppm) も CPU を使う。
    max_instance_request_concurrency = var.request_concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      # ⚠ 既定 (1 vCPU / 512Mi) では、読み取りの並列とページの描画に足りない。
      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      # ⚠ secret は **参照だけ**。値は tfstate に入らない。
      dynamic "env" {
        for_each = var.env_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # /health は Mastra 本体が持つパス (infra/local の compose も同じものを見ている)。
      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 30
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.ai.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.invoker_sa_email}"
}
