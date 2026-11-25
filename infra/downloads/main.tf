# Installer + update-manifest hosting (Story 5.2/5.3, T084).
#
# - A public-read Cloud Storage bucket: `releases/vX.Y.Z/` (immutable, versioned files),
#   `releases/latest/` (stable download links for the install page) and
#   `updates/latest.json` (Tauri updater manifest).
# - Optional Cloud CDN in front of it (HTTPS load balancer + managed certificate), enabled by
#   setting `cdn_domain`. Until a domain exists (ADR-009) clients use the bucket's
#   storage.googleapis.com URL, which Google already serves from its edge.
# - A release service account that GitHub Actions impersonates through Workload Identity
#   Federation, limited to writing this bucket. No JSON keys.
#
#   terraform -chdir=infra/downloads init -backend-config="bucket=sayvox-app-2026-tfstate" -backend-config="prefix=downloads"
#   terraform -chdir=infra/downloads apply -var github_repo=<owner>/<repo>

terraform {
  required_version = ">= 1.6"
  # State in the private GCS bucket (deploy.md step 1), prefix "downloads".
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Bucket ────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "releases" {
  name                        = var.bucket_name
  location                    = var.bucket_location
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"

  # Keep overwritten manifests / latest links for rollback forensics, then expire them.
  versioning {
    enabled = true
  }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 90
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "Content-Length", "ETag"]
    max_age_seconds = 3600
  }
}

# Installers and manifests are public by design (anyone may download Sayvox).
resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.releases.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# ── CI identity (GitHub Actions → release SA, via WIF) ───────────────────

resource "google_service_account" "release" {
  account_id   = "sayvox-release"
  display_name = "Sayvox release uploads (GitHub Actions)"
}

resource "google_storage_bucket_iam_member" "release_write" {
  bucket = google_storage_bucket.releases.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.release.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # Only this repository's workflows can exchange tokens.
  attribute_condition = "assertion.repository == \"${var.github_repo}\""
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "release_wif" {
  service_account_id = google_service_account.release.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ── Optional Cloud CDN (needs a domain) ──────────────────────────────────

locals {
  cdn = var.cdn_domain != "" ? 1 : 0
}

resource "google_compute_backend_bucket" "releases" {
  count       = local.cdn
  name        = "sayvox-releases"
  bucket_name = google_storage_bucket.releases.name
  enable_cdn  = true
  cdn_policy {
    cache_mode = "USE_ORIGIN_HEADERS" # objects carry their own Cache-Control (release.yml)
  }
}

resource "google_compute_url_map" "releases" {
  count           = local.cdn
  name            = "sayvox-releases"
  default_service = google_compute_backend_bucket.releases[0].id
}

resource "google_compute_managed_ssl_certificate" "releases" {
  count = local.cdn
  name  = "sayvox-releases"
  managed {
    domains = [var.cdn_domain]
  }
}

resource "google_compute_target_https_proxy" "releases" {
  count            = local.cdn
  name             = "sayvox-releases"
  url_map          = google_compute_url_map.releases[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.releases[0].id]
}

resource "google_compute_global_address" "releases" {
  count = local.cdn
  name  = "sayvox-releases"
}

resource "google_compute_global_forwarding_rule" "releases" {
  count                 = local.cdn
  name                  = "sayvox-releases"
  target                = google_compute_target_https_proxy.releases[0].id
  ip_address            = google_compute_global_address.releases[0].address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
