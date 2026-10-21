variable "project_id" {
  description = "secret の器を作る GCP プロジェクト。"
  type        = string
}

variable "names" {
  description = "作る secret の名前。"
  type        = set(string)
}

variable "accessors" {
  description = "secret を読める主体 (\"serviceAccount:...\" / \"group:...\")。"
  type        = list(string)
  default     = []
}
