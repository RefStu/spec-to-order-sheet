variable "account_id" {
  description = "Cloudflare のアカウント ID。"
  type        = string
}

variable "worker_name" {
  description = "Worker の名前 (<project>-web)。"
  type        = string
}

variable "d1_name" {
  description = "D1 データベースの名前 (<project>)。"
  type        = string
}

variable "r2_bucket_name" {
  type        = string
  description = "発注書・依頼書の PDF を置く R2 バケットの名前。"
}

variable "queue_name" {
  description = "ジョブ用の Queue 名 (<project>-jobs)。"
  type        = string
}

variable "dlq_name" {
  description = "dead letter queue の名前。"
  type        = string
}

variable "hostname" {
  description = "custom domain。空なら作らない。"
  type        = string
  default     = ""
}

variable "zone_id" {
  description = "hostname を含む Cloudflare ゾーンの ID。"
  type        = string
  default     = ""
}

variable "primary_location_hint" {
  description = "D1 の主レプリカを置く地域 (apac / enam / weur ...)。"
  type        = string
  default     = "apac"
}
