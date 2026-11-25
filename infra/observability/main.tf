# Cloud Monitoring dashboard + alerts for architecture section 16 (T092), the text-free
# product-event sink to BigQuery (T093), and spend alerts (T097). One state per environment,
# applied after infra/terraform:
#
#   terraform -chdir=infra/observability init -backend-config="bucket=sayvox-app-2026-tfstate" -backend-config="prefix=observability/prod"
#   terraform -chdir=infra/observability apply -var env=prod -var alert_email=<you> -var billing_account=<id>
#
# Metric names come from apps/api/src/lib/otel/metrics.ts via the collector sidecar
# (infra/terraform/otel-collector.yaml): workload.googleapis.com/<name>.

terraform {
  required_version = ">= 1.6"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

locals {
  name    = "sayvox-${var.env}"
  service = "sayvox-${var.env}-api"
  wl      = "workload.googleapis.com"
  run     = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.service}\""
  jobs    = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=~\"^${local.name}-\"" # Logging query syntax
  # The collector reports API metrics on generic_task resources whose namespace is the env
  # (otel-collector.yaml), so staging and prod never mix.
  ns = "resource.type=\"generic_task\" AND resource.labels.namespace=\"${var.env}\""
  m = {
    release_to_insert = "metric.type=\"${local.wl}/release_to_insert_ms\" AND ${local.ns}"
    session_start     = "metric.type=\"${local.wl}/session_start_ms\" AND ${local.ns}"
    llm_ttft          = "metric.type=\"${local.wl}/llm_ttft_ms\" AND ${local.ns}"
    rewrites          = "metric.type=\"${local.wl}/rewrite_total\" AND ${local.ns}"
    session_ends      = "metric.type=\"${local.wl}/session_end_total\" AND ${local.ns}"
    requests          = "metric.type=\"run.googleapis.com/request_count\" AND ${local.run}"
  }
  channels = [google_monitoring_notification_channel.email.id]
}

resource "google_project_service" "apis" {
  for_each = toset([
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "bigquery.googleapis.com",
    "billingbudgets.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_monitoring_notification_channel" "email" {
  display_name = "Sayvox on-call (${var.env})"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}
