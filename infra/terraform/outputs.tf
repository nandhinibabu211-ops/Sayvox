output "api_url" {
  description = "run.app URL (API_BASE_URL until a domain exists, ADR-009)."
  value       = google_cloud_run_v2_service.api.uri
}

output "web_url" {
  description = "Web pages (sign-in, install, privacy, terms). Build the desktop app with SAYVOX_WEB_ORIGIN set to this."
  value       = google_cloud_run_v2_service.web.uri
}

output "edge_ip" {
  description = "Point the domain's A record here (only when `domain` is set)."
  value       = var.domain == "" ? null : google_compute_global_address.edge[0].address
}

output "github_vars" {
  description = "GitHub environment variables for deploy.yml (Settings -> Environments -> staging / production)."
  value = {
    GCP_REGION                 = var.region
    GCP_WIF_PROVIDER           = "${data.google_iam_workload_identity_pool.github.name}/providers/github-oidc"
    GCP_DEPLOY_SERVICE_ACCOUNT = google_service_account.deploy.email
    API_SERVICE                = google_cloud_run_v2_service.api.name
    API_REPOSITORY             = "${var.region}-docker.pkg.dev/${var.project_id}/${local.repo_id}"
    MIGRATE_JOB                = google_cloud_run_v2_job.job["migrate"].name
    JOBS                       = join(",", [for k in keys(local.job_args) : google_cloud_run_v2_job.job[k].name])
    # Deterministic URL form (what Identity Platform authorizes and the desktop is built with).
    WEB_ORIGIN   = "https://${google_cloud_run_v2_service.web.name}-${data.google_project.this.number}.${var.region}.run.app"
    API_BASE_URL = var.domain == "" ? google_cloud_run_v2_service.api.uri : "https://${var.domain}"
  }
}

output "db_password" {
  description = "Password for the AlloyDB Express `postgres` user (staging): pass it to gcloud without printing it (deploy.md)."
  value       = random_password.db.result
  sensitive   = true
}

output "owner_secrets" {
  description = "Secret Manager secrets the owner must add a version to before the first deploy."
  value       = [for k in keys(local.owner_secrets) : local.all_secrets[k]]
}
