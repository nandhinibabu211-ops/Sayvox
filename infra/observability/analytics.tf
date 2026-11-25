# Text-free product events (T093): the desktop app posts dictation_started / _inserted,
# mode_changed, fallback_used and quota_hit to /v1/telemetry, which logs them as
# `telemetry: "event"` lines with no user id (apps/api/src/modules/telemetry). This sink
# copies just those lines into a partitioned BigQuery dataset for product analytics.

resource "google_bigquery_dataset" "events" {
  dataset_id                      = replace("${local.name}_events", "-", "_")
  location                        = "US"
  description                     = "Sayvox product events (no user ids, no text)"
  default_partition_expiration_ms = var.events_retention_days * 86400000
  delete_contents_on_destroy      = false
  depends_on                      = [google_project_service.apis]
}

resource "google_logging_project_sink" "events" {
  name                   = "${local.name}-product-events"
  destination            = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.events.dataset_id}"
  filter                 = "${local.run} AND jsonPayload.telemetry=\"event\""
  unique_writer_identity = true
  bigquery_options {
    use_partitioned_tables = true
  }
}

resource "google_bigquery_dataset_iam_member" "sink_writer" {
  dataset_id = google_bigquery_dataset.events.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.events.writer_identity
}
