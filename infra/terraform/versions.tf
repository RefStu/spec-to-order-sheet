terraform {
  required_version = ">= 1.13"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.25"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.region
}

# Identity Platform (GIP) と API キー専用。
# ⚠ identitytoolkit と apikeys は quota project を要求する API で、既定の provider のままだと
#   手元の ADC (gcloud auth application-default login) では 403 になる。
#   user_project_override で X-Goog-User-Project を送り、billing_project で更新時の
#   quota project もこのプロジェクトに固定する (呼ぶ人に serviceusage.services.use が要る)。
# ⚠ 既定の provider には入れない。必要な resource だけがこの provider を使う。
provider "google" {
  alias   = "quota"
  project = var.gcp_project_id
  region  = var.region

  user_project_override = true
  billing_project       = var.gcp_project_id
}

# ⚠ API トークンは環境変数 CLOUDFLARE_API_TOKEN から読む (provider の既定)。ここには書かない。
provider "cloudflare" {}
