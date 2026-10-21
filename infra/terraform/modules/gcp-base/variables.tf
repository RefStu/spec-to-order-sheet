variable "project_id" {
  description = "GCP プロジェクト ID。"
  type        = string
}

variable "region" {
  description = "Artifact Registry と Cloud Run を置くリージョン。"
  type        = string
}

variable "repository_id" {
  description = "Artifact Registry のリポジトリ名。"
  type        = string
  default     = "apps"
}

variable "services" {
  description = "有効にする GCP API。"
  type        = list(string)
  default = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    # 利用者の認証。identitytoolkit = Identity Platform 本体、
    # apikeys = ブラウザが Identity Toolkit を呼ぶための API キーを作るため。
    "identitytoolkit.googleapis.com",
    "apikeys.googleapis.com",
  ]
}

variable "keep_image_count" {
  description = "Artifact Registry に残す image の数。"
  type        = number
  default     = 20
}
