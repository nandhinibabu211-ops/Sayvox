# Cheap staging (2026-11-25): serverless AlloyDB Express + free-tier Redis VM, in us-west1
# (the only US region with AlloyDB Express; e2-micro is free there). Prod stays us-east4.
env                   = "staging"
region                = "us-west1"
github_repo           = "nandhinibabu211-ops/Sayvox"
min_instances         = 0
max_instances         = 2
database              = "alloydb_express"
redis                 = "vm"
db_connect_timeout_ms = 30000
# Speech-to-text through OpenRouter (owner, 2026-11-26); list a provider key here only
# after adding its secret version in Secret Manager.
stt_provider  = "openrouter"
provider_keys = ["OPENROUTER_API_KEY"]
# Set after creating the AlloyDB Express instance (deploy.md "Staging database"):
alloydb_psc_attachment = "projects/aeca1de70a693c723p-tp/regions/us-west1/serviceAttachments/alloydb-8402accf-5d0-aeca1de70a693c72-sa"
