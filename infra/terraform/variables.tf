# 値は terraform.tfvars で渡す (terraform.tfvars.example をコピーして埋める)。

variable "project_name" {
  description = <<-EOT
    リソース名の接頭辞。Worker / D1 / R2 / Queue の名前になる。
    ⚠ apps/web/wrangler.jsonc の name / database_name / bucket_name / queue と同じ文字列に
      なるようにすること (ずれると deploy が別のリソースを探しに行き、Queue は配送されない)。
  EOT
  type        = string
  default     = "spec-to-order-sheet"
}

variable "gcp_project_id" {
  description = "Cloud Run / Secret Manager / Artifact Registry / Identity Platform を置く GCP プロジェクト。"
  type        = string
}

variable "region" {
  description = "Cloud Run と Artifact Registry のリージョン。"
  type        = string
  default     = "asia-northeast1"
}

variable "cloudflare_account_id" {
  description = "Worker / D1 / R2 / Queue を置く Cloudflare のアカウント ID。"
  type        = string
}

variable "domain" {
  description = "Worker の custom domain (例: app.your-domain.test)。空なら作らず、workers.dev の URL で公開する。"
  type        = string
  default     = ""
}

variable "cloudflare_zone_id" {
  description = <<-EOT
    domain を含む Cloudflare ゾーンの ID。domain を設定するときだけ必要。
    ⚠ ゾーン名から引く data source は使わない (plan が実 API を叩くようになり、
      資格情報なしの validate ができなくなる)。ID をそのまま書く。
  EOT
  type        = string
  default     = ""
}

variable "turso_url" {
  description = <<-EOT
    Mastra の保存先 (libsql://<db>-<org>.<location>.turso.io)。Cloud Run の LIBSQL_URL になる。
    Turso の DB は Terraform では作らない (公式 provider が無い)。turso CLI で作った値を書く。
  EOT
  type        = string
}

variable "ai_image" {
  description = <<-EOT
    Cloud Run に載せる image。
    ⚠ **digest (@sha256:...) で渡す。** tag だと同じ tag を押し直したときに
      Terraform が差分を検出せず、revision が更新されない。
    初回 (secret の器と Artifact Registry だけを作る段階) は空でよい。
  EOT
  type        = string
  default     = ""
}

variable "ai_default_model" {
  description = "ai の既定モデル (AI_DEFAULT_MODEL)。apps/ai が受け付ける ID であること。"
  type        = string
  default     = "openai/gpt-5-mini"
}

variable "ai_request_timeout_ms" {
  description = <<-EOT
    読み取り 1 回ぶんの上限 (ミリ秒)。ai の AI_REQUEST_TIMEOUT_MS になり、
    Cloud Run の request timeout もここから導く (locals.tf)。
  EOT
  type        = number
  default     = 900000
}

variable "ai_min_instances" {
  type    = number
  default = 0
}

variable "ai_max_instances" {
  type    = number
  default = 3
}

variable "deletion_protection" {
  description = "Cloud Run を terraform destroy で消せないようにする。"
  type        = bool
  default     = false
}

variable "secret_readers" {
  description = <<-EOT
    secret の値を読める主体を足す ("user:..." / "group:..." / "serviceAccount:...")。
    Cloud Run の runtime SA は常に読める。
  EOT
  type        = list(string)
  default     = []
}

variable "d1_location_hint" {
  description = "D1 の主レプリカを置く地域 (apac / enam / weur ...)。"
  type        = string
  default     = "apac"
}
