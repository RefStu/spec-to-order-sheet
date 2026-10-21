# 利用者の認証 — Google Identity Platform (GIP)。
#
# ⚠⚠ **利用者は tenant に置く。** project 直下には誰も置かない。iss / aud はどの tenant でも
#   同じなので、Worker は ID token の firebase.tenant を GIP_TENANT_ID と突き合わせて、
#   この tenant 以外の利用者を落とす (apps/web/src/shared/auth/verify.ts)。
#
# ⚠⚠ **自己登録 (accounts:signUp) は閉じる。** Web API キーはブラウザに配る公開値なので、
#   開けておくと、キーを見た人が誰でもアカウントを作って入れる。
#   project と tenant の両方で disabled_user_signup = true にする。
#   Admin API からの作成はこの設定に関係なく通る。
#
# ⚠ **利用者は Terraform では作れない** (provider に利用者のリソースが無い)。
#   作り方は README.md の「利用者を作る」。

# ⚠ project 単位のシングルトン。同じ GCP プロジェクトで別の Terraform root が
#   これを持っているなら、ここは import するか外すこと (奪い合って毎回差分が出る)。
resource "google_identity_platform_config" "this" {
  provider = google.quota
  project  = var.gcp_project_id

  sign_in {
    # メールアドレス + パスワードだけを有効にする。
    email {
      enabled = true
      # ⚠ false にするとパスワード無し (メールリンク) でも入れてしまう。
      password_required = true
    }
  }

  # ⚠ tenant はこれが true になってからでないと作れない。
  multi_tenant {
    allow_tenants = true
  }

  client {
    permissions {
      disabled_user_signup = true
    }
  }

  # JS SDK / OAuth のリダイレクト先として許すホスト。
  # ⚠ いまの実装は Identity Toolkit の REST を直接叩くのでここは効かないが、
  #   あとで SDK を入れたときに効く。
  authorized_domains = compact([
    "localhost",
    "127.0.0.1",
    var.domain,
  ])

  depends_on = [module.gcp_base]
}

# ⚠ display_name は英字で始まり 4〜20 文字 (英数字とハイフン)。tenant ID はここから
#   GCP が作る (users-xxxxx)。値は output gip_tenant_id。
resource "google_identity_platform_tenant" "users" {
  provider = google.quota

  project               = var.gcp_project_id
  display_name          = "users"
  allow_password_signup = true

  client {
    permissions {
      disabled_user_signup = true
    }
  }

  depends_on = [google_identity_platform_config.this]
}

# ブラウザが Identity Toolkit を呼ぶための API キー。
#
# ⚠ **値 (key_string) を output しない。** output すると tfstate に平文で残る。
#   値は gcloud で取り出して secret「gip-api-key」に入れる (README.md)。
# ⚠ このキーは**ブラウザに配る前提の公開値**で、秘密ではない。守っているのは
#   「Terraform に値を運ばせない」という一貫性のほう。
resource "google_apikeys_key" "gip_web" {
  provider = google.quota

  project      = var.gcp_project_id
  name         = "gip-web-key"
  display_name = "GIP web sign-in"

  restrictions {
    # Identity Toolkit (サインイン) と Secure Token (ID token の更新) 以外には使えないようにする。
    # ⚠ securetoken を外すと、ログインから 1 時間後の更新が 403 になる
    #   (apps/web/src/shared/auth/identity-toolkit.ts の REFRESH_URL)。
    api_targets {
      service = "identitytoolkit.googleapis.com"
    }
    api_targets {
      service = "securetoken.googleapis.com"
    }
  }

  depends_on = [module.gcp_base]
}
