# tfstate の置き場所。既定はローカル (このディレクトリの terraform.tfstate)。
#
# ⚠ tfstate はリポジトリにコミットしない (.gitignore 済み)。
# 複数人で扱うなら GCS に置く。bucket を先に作り (バージョニングを有効にする)、
# 下のコメントを外して `terraform init -migrate-state` を実行する。
#
# terraform {
#   backend "gcs" {
#     bucket = "<your-tfstate-bucket>"
#     prefix = "spec-to-order-sheet"
#   }
# }
