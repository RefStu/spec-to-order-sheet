# ⚠ モジュールにも required_providers が要る。書かないと terraform は
#   provider 名 (cloudflare / google) から hashicorp/<name> を推測し、init で落ちる。
#   provider ブロック (認証の設定) は root 側 (infra/terraform/versions.tf) だけが持つ。
terraform {
  required_version = ">= 1.13"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
