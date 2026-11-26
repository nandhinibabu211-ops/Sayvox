# ── Cloud Run: API service + OTel collector sidecar ──────────────────────
# The image is set by .github/workflows/deploy.yml (Terraform ignores later image changes).
# The first apply uses a placeholder image until the first deploy.

locals {
  image_placeholder = var.initial_image
  node_env          = var.env == "prod" ? "production" : "staging"
  plain_env = {
    NODE_ENV                    = local.node_env
    GCP_PROJECT_ID              = var.project_id
    REGION                      = var.region
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
    RAZORPAY_PLAN_IDS           = var.razorpay_plan_ids
    DB_CONNECT_TIMEOUT_MS       = tostring(var.db_connect_timeout_ms)
    # The web app (web.tf) calls the API from the browser; the desktop webview origins are
    # built in (apps/api/src/plugins/cors.ts).
    CORS_ORIGINS = "https://${local.name}-web-${data.google_project.this.number}.${var.region}.run.app"
  }
  # `cfg` is the runtime-config CLI (kill switch, rollout, min version) run inside the VPC,
  # because Memorystore has no public address. Run it with
  #   gcloud run jobs execute sayvox-prod-cfg --region us-east4 --wait --args=src/scripts/cfg.ts,get
  # (docs/runbooks/kill-switch.md). Its JSON output in Cloud Logging is the audit trail.
  job_secrets = {
    cfg       = ["REDIS_URL"]
    migrate   = ["DATABASE_URL", "REDIS_URL"]
    reconcile = ["DATABASE_URL", "ELEVENLABS_API_KEY"]
    spend     = ["DATABASE_URL"]
  }
  # Owner-provided secrets are mounted only once they have a version (Cloud Run refuses a
  # revision whose secret has none): provider_keys_ready = false runs the API without them.
  mounted_secrets = {
    for k, v in local.all_secrets : k => v
    if var.provider_keys_ready || !contains(keys(local.owner_secrets), k)
  }
  job_args = {
    cfg       = ["src/scripts/cfg.ts", "get"]
    migrate   = ["src/scripts/db.ts", "setup"]
    reconcile = ["src/scripts/job.ts", "reconcile"]
    spend     = ["src/scripts/job.ts", "spend"]
  }
}

resource "google_cloud_run_v2_service" "api" {
  name                = "${local.name}-api"
  location            = var.region
  deletion_protection = var.env == "prod"
  ingress             = var.domain != "" && var.lb_only_ingress ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.runtime.email
    max_instance_request_concurrency = 80

    # Also the longest a /v1/stream WebSocket may live: max session (300 s) + commit slack.
    timeout = "600s"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }

    containers {
      name       = "api"
      image      = local.image_placeholder
      depends_on = ["collector"]
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = var.env != "prod"
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.plain_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.mounted_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.key].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 2
        failure_threshold = 15
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds = 30
      }
    }

    containers {
      name  = "collector"
      image = var.otel_collector_image
      args  = ["--config=/etc/otelcol-google/config.yaml"]
      env {
        name  = "SAYVOX_ENV"
        value = var.env
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }
      volume_mounts {
        name       = "otel-config"
        mount_path = "/etc/otelcol-google/"
      }
      startup_probe {
        http_get {
          path = "/"
          port = 13133
        }
        period_seconds    = 2
        failure_threshold = 15
      }
    }

    volumes {
      name = "otel-config"
      secret {
        secret = google_secret_manager_secret.otel_config.secret_id
        items {
          version = "latest"
          path    = "config.yaml"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
      template[0].revision,
      template[0].labels,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime,
    google_secret_manager_secret_iam_member.otel_config,
    google_secret_manager_secret_version.generated,
    google_secret_manager_secret_version.otel_config,
  ]
}

# The desktop app calls the API directly (or through the load balancer, edge.tf);
# authentication is the app's Identity Platform token, not IAM.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Cloud Run jobs: migrations and scheduled checks (T096, T097) ─────────

resource "google_cloud_run_v2_job" "job" {
  for_each            = local.job_args
  name                = "${local.name}-${each.key}"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account = google_service_account.runtime.email
      max_retries     = contains(["migrate", "cfg"], each.key) ? 0 : 1
      timeout         = "600s"
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.vpc.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }
      containers {
        image   = local.image_placeholder
        command = ["node", "--import", "tsx"]
        args    = each.value
        env {
          name  = "NODE_ENV"
          value = local.node_env
        }
        env {
          name  = "DB_CONNECT_TIMEOUT_MS"
          value = tostring(var.db_connect_timeout_ms)
        }
        dynamic "env" {
          for_each = toset([for s in local.job_secrets[each.key] : s if contains(keys(local.mounted_secrets), s)])
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.s[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version, template[0].labels]
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime]
}

resource "google_service_account" "scheduler" {
  account_id   = "${local.name}-scheduler"
  display_name = "Sayvox scheduled jobs (${var.env})"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler" {
  for_each = toset(["reconcile", "spend"])
  name     = google_cloud_run_v2_job.job[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "job" {
  for_each = {
    reconcile = "0 3 * * 1"  # Mondays 03:00 UTC, the previous 7 full days
    spend     = "30 0 * * *" # daily 00:30 UTC, yesterday vs the 7 days before
  }
  name      = "${local.name}-${each.key}"
  region    = var.region
  schedule  = each.value
  time_zone = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.job[each.key].name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.scheduler]
}
