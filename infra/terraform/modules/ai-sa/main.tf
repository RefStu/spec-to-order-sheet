# ai (Cloud Run) が使う 2 つの SA。
#
# ⚠⚠ **ai-service から出してあるのは、依存の向きを SA → secrets → ai にするため。**
#   secrets の accessors に runtime SA が要るので、SA が ai-service の中にあると
#   向きが ai → secrets になり、**secret の器より先に Cloud Run が作られる**。
#   版が 1 つも無い secret を secret_key_ref (version = "latest") でマウントすると
#   revision の作成ごと失敗するので、この向きを戻さないこと。
#   おかげで初回の `-target=module.ai_sa -target=module.secrets` が module.ai を巻き込まない。
# ⚠ **鍵はここで作らない。** google_service_account_key は tfstate に秘密鍵が平文で残る。
#   invoker SA の鍵は gcloud で作る (README.md)。

resource "google_service_account" "runtime" {
  project = var.project_id
  # ⚠ account_id は 6〜30 文字。
  account_id   = "ai-run"
  display_name = "Cloud Run runtime (ai)"
}

resource "google_service_account" "invoker" {
  project      = var.project_id
  account_id   = "ai-invoker"
  display_name = "Worker から ai を呼ぶための SA"
}
