# ⚠ モジュールにも required_providers が要る。書かないと terraform は
#   provider 名 (cloudflare) から hashicorp/cloudflare を推測し、init で落ちる。
terraform {
  required_version = ">= 1.13"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.25"
    }
  }
}
