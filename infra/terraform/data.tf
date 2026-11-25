# Database and cache. Two shapes:
# - prod: Cloud SQL (Postgres) + Memorystore, private IPs over VPC peering.
# - cheap staging: AlloyDB Express (serverless Postgres, scales to zero; created with gcloud
#   because Terraform doesn't support it yet, docs/runbooks/deploy.md) reached through a
#   Private Service Connect endpoint, plus Redis on a free-tier e2-micro VM (lite.tf).

locals {
  cloudsql    = var.database == "cloudsql"
  alloydb     = var.database == "alloydb_express"
  memorystore = var.redis == "memorystore"
  peering     = local.cloudsql || local.memorystore
}

# ── Cloud SQL (Postgres, encrypted at rest by default) ───────────────────

resource "google_sql_database_instance" "db" {
  count               = local.cloudsql ? 1 : 0
  name                = local.name
  database_version    = "POSTGRES_17"
  region              = var.region
  deletion_protection = var.env == "prod"

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.env == "prod"
      start_time                     = "20:30" # 02:00 IST
      backup_retention_settings {
        retained_backups = var.env == "prod" ? 14 : 3
      }
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }
  }
  depends_on = [google_service_networking_connection.services]
}

resource "google_sql_database" "sayvox" {
  count    = local.cloudsql ? 1 : 0
  name     = "sayvox"
  instance = google_sql_database_instance.db[0].name
}

# Meets AlloyDB's default complexity policy; specials limited to URL-safe characters so the
# password can sit in DATABASE_URL unescaped.
resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "-_.~"
  min_special      = 2
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
}

resource "google_sql_user" "api" {
  count    = local.cloudsql ? 1 : 0
  name     = "sayvox"
  instance = google_sql_database_instance.db[0].name
  password = random_password.db.result
}

# ── Memorystore (Redis: quotas, rate limits, config cache) ───────────────

resource "google_redis_instance" "cache" {
  count              = local.memorystore ? 1 : 0
  name               = local.name
  tier               = var.redis_tier
  memory_size_gb     = 1
  region             = var.region
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.vpc.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  auth_enabled       = true
  depends_on         = [google_service_networking_connection.services]
}

# ── Secrets ──────────────────────────────────────────────────────────────
# Connection strings are generated here (so they live in the Terraform state too: keep the
# state bucket private). Provider keys are added by the owner, never through Terraform:
#   gcloud secrets versions add sayvox-staging-elevenlabs-api-key --data-file=-
# Rotate every 90 days (architecture section 11, docs/runbooks/deploy.md).

locals {
  owner_secrets = merge(
    {
      ELEVENLABS_API_KEY = "elevenlabs-api-key"
      OPENROUTER_API_KEY = "openrouter-api-key"
    },
    var.billing_enabled ? {
      RAZORPAY_KEY_ID         = "razorpay-key-id"
      RAZORPAY_KEY_SECRET     = "razorpay-key-secret"
      RAZORPAY_WEBHOOK_SECRET = "razorpay-webhook-secret"
    } : {},
  )
  # TLS is required on both databases; the server certificates are Google-managed, so the
  # client encrypts without pinning them.
  database_url = (
    local.cloudsql
    ? "postgres://sayvox:${random_password.db.result}@${google_sql_database_instance.db[0].private_ip_address}:5432/sayvox?sslmode=no-verify"
    : length(google_compute_address.alloydb_psc) > 0
    ? "postgres://postgres:${random_password.db.result}@${google_compute_address.alloydb_psc[0].address}:5432/postgres?sslmode=no-verify"
    : ""
  )
  redis_url = (
    local.memorystore
    ? "redis://:${google_redis_instance.cache[0].auth_string}@${google_redis_instance.cache[0].host}:${google_redis_instance.cache[0].port}"
    : "redis://:${random_password.redis.result}@${google_compute_instance.redis[0].network_interface[0].network_ip}:6379"
  )
  # DATABASE_URL waits until the AlloyDB Express PSC endpoint exists (second apply). The
  # key set depends only on settings, never on the (sensitive) values.
  generated_secrets = { REDIS_URL = local.redis_url, DATABASE_URL = local.database_url }
  generated_keys = toset(
    local.cloudsql || var.alloydb_psc_attachment != "" ? ["REDIS_URL", "DATABASE_URL"] : ["REDIS_URL"]
  )
  all_secrets = merge(
    { for k, v in local.owner_secrets : k => "${local.name}-${v}" },
    { DATABASE_URL = "${local.name}-database-url", REDIS_URL = "${local.name}-redis-url" },
  )
}

resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.all_secrets
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = local.generated_keys
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = local.generated_secrets[each.key]
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.all_secrets
  secret_id = google_secret_manager_secret.s[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# Collector config for the Cloud Run sidecar, mounted as a file.
resource "google_secret_manager_secret" "otel_config" {
  secret_id = "${local.name}-otel-collector-config"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "otel_config" {
  secret      = google_secret_manager_secret.otel_config.id
  secret_data = file("${path.module}/otel-collector.yaml")
}

resource "google_secret_manager_secret_iam_member" "otel_config" {
  secret_id = google_secret_manager_secret.otel_config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
