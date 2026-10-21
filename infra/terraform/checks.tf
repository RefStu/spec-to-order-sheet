# 設定の取り違えを plan の時点で止める。
#
# ⚠ **check ブロックではなく precondition を使う。** check は warning にしかならず、
#   壊れた設定のまま apply が通ってしまう。
# ⚠ terraform_data は provider を要らないので、資格情報なしの plan でも評価される。
# ⚠ 初回に -target で器だけを作る段階では、このリソースは対象外なので評価されない
#   (ai_image が空のままでも通る)。

resource "terraform_data" "guard" {
  input = var.project_name

  lifecycle {
    # ⚠ Cloud Run の上限は 3600 秒。超えると apply がエラーになるので plan で止める。
    precondition {
      condition     = local.ai_request_timeout_seconds <= 3600
      error_message = "ai_request_timeout_ms が長すぎます (Cloud Run の上限は 3600 秒、いまは余裕の 60 秒込みで ${local.ai_request_timeout_seconds} 秒ぶん要求しています)。"
    }

    precondition {
      condition     = var.ai_image != ""
      error_message = "ai_image が空です。image を Artifact Registry に push し、digest (@sha256:...) 付きで terraform.tfvars に書いてください (README.md)。"
    }

    precondition {
      condition     = var.domain == "" || var.cloudflare_zone_id != ""
      error_message = "domain を設定するときは cloudflare_zone_id も必要です。"
    }

    precondition {
      condition     = !can(regex("CHANGE-?ME|TODO|[<>]", join(" ", [var.gcp_project_id, var.cloudflare_account_id, var.turso_url, var.project_name])))
      error_message = "terraform.tfvars に CHANGE-ME / <...> が残っています (gcp_project_id / cloudflare_account_id / turso_url / project_name)。"
    }
  }
}
