output "download_base_url" {
  description = "Base URL for installers and the update manifest."
  value = var.cdn_domain != "" ? "https://${var.cdn_domain}" : "https://storage.googleapis.com/${google_storage_bucket.releases.name}"
}

output "cdn_ip" {
  description = "Point the CDN domain's A record here (only with cdn_domain)."
  value       = var.cdn_domain != "" ? google_compute_global_address.releases[0].address : null
}

# Set these as GitHub repository variables for .github/workflows/release.yml.
output "github_vars" {
  value = {
    RELEASE_BUCKET              = google_storage_bucket.releases.name
    GCP_WIF_PROVIDER            = google_iam_workload_identity_pool_provider.github.name
    GCP_RELEASE_SERVICE_ACCOUNT = google_service_account.release.email
  }
}
