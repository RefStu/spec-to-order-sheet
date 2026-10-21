output "secret_paths" {
  description = <<-EOT
    secret 名 → Cloud Run の secret_key_ref に入れる完全名。
    ⚠ 完全名 (projects/<project>/secrets/<name>) で書く。同じプロジェクトでも通るうえ、
      あとで secret を別プロジェクトへ移しても参照の形が変わらない。
  EOT
  # ⚠⚠ **var.names ではなく google_secret_manager_secret から作ること。**
  #   module の output ノードは「value の式が参照しているもの」にしか依存しない。
  #   変数だけから組み立てると依存グラフは「output → 変数」で終わり、
  #   受け取った側 (module.ai) は **器より先に作られる**。
  #   文字列としては同じものが出るので、差し替えても気付けない。
  value = {
    for name, secret in google_secret_manager_secret.this :
    name => "projects/${var.project_id}/secrets/${secret.secret_id}"
  }
}
