locals {
  name = "sayvox-${var.env}"
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "alloydb.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
    "cloudscheduler.googleapis.com",
    "monitoring.googleapis.com",
    "cloudtrace.googleapis.com",
    "logging.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudbuild.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

data "google_project" "this" {}

# ── Container registry ───────────────────────────────────────────────────
# One repository for both environments: deploy.yml builds an image once, staging runs it,
# and prod deploys that same image. Created by the staging apply (apply staging first).

locals {
  repo_id = "sayvox-api"
}

resource "google_artifact_registry_repository" "api" {
  count         = var.env == "staging" ? 1 : 0
  repository_id = local.repo_id
  location      = var.region
  format        = "DOCKER"
  description   = "Sayvox API images (built once, deployed to staging then prod)"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 30
    }
  }
  cleanup_policies {
    id     = "drop-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days, beyond the 30 most recent
    }
  }
  depends_on = [google_project_service.apis]
}

# ── Identities (least privilege, architecture section 15) ─────────────────

resource "google_service_account" "runtime" {
  account_id   = "${local.name}-api"
  display_name = "Sayvox API runtime (${var.env})"
}

resource "google_project_iam_member" "runtime" {
  for_each = toset([
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
    "roles/errorreporting.writer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Identity Platform token verification needs no role (public signing keys).

resource "google_service_account" "deploy" {
  account_id   = "${local.name}-deploy"
  display_name = "Sayvox API deploys from GitHub Actions (${var.env})"
}

resource "google_project_iam_member" "deploy" {
  for_each = toset([
    "roles/run.developer",
    "roles/monitoring.viewer", # rollout watch reads Cloud Run request metrics
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# Staging deploys push images; prod deploys only read them.
resource "google_artifact_registry_repository_iam_member" "deploy" {
  repository = local.repo_id
  location   = var.region
  role       = var.env == "staging" ? "roles/artifactregistry.writer" : "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.deploy.email}"
  depends_on = [google_artifact_registry_repository.api]
}

# Deploys run revisions and jobs as the runtime SA.
resource "google_service_account_iam_member" "deploy_act_as" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

data "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = var.wif_pool_id
}

# Only this repository's workflows can deploy. Prod deploys additionally wait for a
# required reviewer on the GitHub "production" environment (deploy.yml).
resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${data.google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
