# Secret Manager の **器だけ**。
#
# ⚠⚠ **値 (google_secret_manager_secret_version) をここで作らない。**
#   Terraform に secret の値を渡すと、tfstate に平文で残る。値は
#   `gcloud secrets versions add` で入れる (README.md)。

resource "google_secret_manager_secret" "this" {
  for_each = var.names

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }
}

locals {
  grants = {
    for pair in setproduct(tolist(var.names), var.accessors) :
    "${pair[0]}|${pair[1]}" => { secret = pair[0], member = pair[1] }
  }
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = local.grants

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}
