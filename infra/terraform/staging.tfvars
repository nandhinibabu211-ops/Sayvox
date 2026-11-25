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
# Provider keys are added later (owner, 2026-11-25); set true after adding their versions.
provider_keys_ready = false
# Set after creating the AlloyDB Express instance (deploy.md "Staging database"):
alloydb_psc_attachment = "projects/aeca1de70a693c723p-tp/regions/us-west1/serviceAttachments/alloydb-8402accf-5d0-aeca1de70a693c72-sa"
