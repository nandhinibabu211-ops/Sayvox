# Web pages (landing, sign-in, install, privacy, terms) on Cloud Run, instead of Firebase
# Hosting (owner decision 2026-11-26). Built by apps/web/Dockerfile; the image is set by
# deploys (Terraform ignores later changes). The service URL is deterministic:
# https://sayvox-<env>-web-<project number>.<region>.run.app, which the desktop app is
# built with (SAYVOX_WEB_ORIGIN) and Identity Platform lists as an authorized domain.

resource "google_service_account" "web" {
  account_id   = "${local.name}-web"
  display_name = "Sayvox web pages (${var.env})"
}

resource "google_cloud_run_v2_service" "web" {
  name                = "${local.name}-web"
  location            = var.region
  deletion_protection = var.env == "prod"
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.web.email
    max_instance_request_concurrency = 200
    scaling {
      min_instance_count = 0
      max_instance_count = var.env == "prod" ? 5 : 2
    }
    containers {
      image = var.initial_web_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }
      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 2
        failure_threshold = 10
      }
    }
  }

  # Image and env (FIREBASE_API_KEY, GOOGLE_SIGNIN) are set by deploy.yml from GitHub
  # environment variables, so the public key never sits in this repository.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      client,
      client_version,
      template[0].revision,
      template[0].labels,
    ]
  }
  depends_on = [google_project_service.apis]
}

# Deploys run web revisions as the web SA.
resource "google_service_account_iam_member" "deploy_act_as_web" {
  service_account_id = google_service_account.web.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  name     = google_cloud_run_v2_service.web.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
