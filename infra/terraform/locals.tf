locals {
  # ⚠ apps/web/wrangler.jsonc と同じ文字列にする (variables.tf の project_name)。
  service_ai     = "${var.project_name}-ai"
  worker         = "${var.project_name}-web"
  d1_name        = var.project_name
  r2_bucket_name = "${var.project_name}-files"
  queue_name     = "${var.project_name}-jobs"
  dlq_name       = "${var.project_name}-jobs-dlq"

  # ★ Cloud Run が 1 リクエストを待つ上限。アプリ側 (AI_REQUEST_TIMEOUT_MS) と同じ変数から導く。
  # ⚠ **短いほうで切れる。** Cloud Run の既定は 300 秒なので、アプリ側だけ延ばしても
  #   ai が仕事を終える前に 504 で捨てられる。
  # ⚠ 余裕を 60 秒足す。アプリ側が先に切れて 504 を返すのが正しい順番で、
  #   Cloud Run に先に切られるとアプリ側のログに何も残らない。上限は checks.tf が見る。
  ai_request_timeout_seconds = ceil(var.ai_request_timeout_ms / 1000) + 60

  # Cloud Run (ai) の環境変数 (値)。
  ai_env = {
    AI_DEFAULT_MODEL      = var.ai_default_model
    AI_REQUEST_TIMEOUT_MS = tostring(var.ai_request_timeout_ms)
    LIBSQL_URL            = var.turso_url
  }

  # Cloud Run (ai) の環境変数 → Secret Manager の secret 名 (値は Terraform の外で入れる)。
  ai_env_secrets = {
    OPENAI_API_KEY    = "openai-api-key"
    LIBSQL_AUTH_TOKEN = "turso-token"
  }

  # Worker の secret (wrangler secret put で入れる値の置き場所)。器だけ作る。
  web_env_secrets = {
    AI_INVOKER_SA_KEY = "ai-invoker-sa-key"
    GIP_API_KEY       = "gip-api-key"
  }

  # ⚠⚠ **ここに module.ai を書かないこと。** 書くと依存が ai → secrets の向きになり、
  #   secret の器より先に Cloud Run が作られる (版が 1 つも無い secret を
  #   secret_key_ref でマウントすると revision の作成ごと失敗する)。
  #   SA を modules/ai-sa に出してあるのは、この向きを保つため。
  secret_accessors = concat(
    ["serviceAccount:${module.ai_sa.runtime_sa_email}"],
    var.secret_readers,
  )
}
