variable "project_id" {
  description = "Cloud Run を置く GCP プロジェクト。"
  type        = string
}

variable "region" {
  type = string
}

variable "runtime_sa_email" {
  description = <<-EOT
    Cloud Run の revision が名乗る SA (modules/ai-sa)。
    ⚠ この SA が secret の accessor になっている必要がある。Cloud Run は revision を
      作るときに secret_key_ref を解決するので、権限が無いと revision ごと失敗する。
  EOT
  type        = string
}

variable "invoker_sa_email" {
  description = "この Cloud Run を呼べる SA (modules/ai-sa)。Worker がこの SA の鍵で ID token を作る。"
  type        = string
}

variable "service_name" {
  description = "Cloud Run のサービス名 (<project>-ai)。"
  type        = string
}

variable "image" {
  description = <<-EOT
    Cloud Run に載せる image。
    ⚠ **digest (@sha256:...) で渡すこと。** tag だと同じ tag を押し直したときに
      Terraform が差分を検出せず、revision が更新されない。
  EOT
  type        = string
}

variable "env" {
  description = "Cloud Run の環境変数 (値)。"
  type        = map(string)
  default     = {}
}

variable "env_secrets" {
  description = "環境変数名 → Secret Manager の完全名 (projects/<p>/secrets/<n>)。"
  type        = map(string)
  default     = {}
}

# ⚠⚠ **既定値をここに書かない。** root の locals.tf が ai_request_timeout_ms から導く。
#   ここに default を置くと**正が 2 つになる**。
variable "request_timeout_seconds" {
  description = <<-EOT
    Cloud Run が 1 リクエストを待つ上限 (秒。上限 3600)。
    ⚠ アプリ側の AI_REQUEST_TIMEOUT_MS **以上**にすること。短いほうで切れる。
  EOT
  type        = number
}

variable "request_concurrency" {
  type    = number
  default = 2
}

variable "cpu" {
  type    = string
  default = "2"
}

variable "memory" {
  type    = string
  default = "1Gi"
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 3
}

variable "deletion_protection" {
  type    = bool
  default = false
}
