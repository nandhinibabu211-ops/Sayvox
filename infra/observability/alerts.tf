# Alert policies: one per row of architecture section 16.

locals {
  latency_alerts = {
    # Release -> inserted p95: dictation > 1.2 s, prompt/email (AI rewrite) > 3 s.
    dictation_p95 = {
      name      = "Release to inserted p95 > 1.2 s (dictation)"
      filter    = "${local.m.release_to_insert} AND metric.labels.mode=\"dictation\""
      threshold = 1200
    }
    prompt_p95 = {
      name      = "Release to inserted p95 > 3 s (prompt, email)"
      filter    = "${local.m.release_to_insert} AND metric.labels.mode!=\"dictation\""
      threshold = 3000
    }
    session_start_p95 = {
      name      = "/v1/session/start p95 > 250 ms"
      filter    = local.m.session_start
      threshold = 250
    }
  }
  ratio_alerts = {
    api_errors = {
      name        = "API 5xx > 1 %"
      numerator   = "${local.m.requests} AND metric.labels.response_code_class=\"5xx\""
      denominator = local.m.requests
      threshold   = 0.01
      duration    = "300s"
    }
    fallback = {
      name        = "LLM fallback > 5 % for 10 min"
      numerator   = "${local.m.rewrites} AND metric.labels.outcome!=\"ok\""
      denominator = local.m.rewrites
      threshold   = 0.05
      duration    = "600s"
    }
    scribe_disconnects = {
      name        = "Scribe disconnects > 1 %"
      numerator   = "${local.m.session_ends} AND metric.labels.scribe_retried=\"true\""
      denominator = local.m.session_ends
      threshold   = 0.01
      duration    = "900s"
    }
  }
}

resource "google_monitoring_alert_policy" "latency" {
  for_each              = local.latency_alerts
  display_name          = "[${var.env}] ${each.value.name}"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "WARNING"

  conditions {
    display_name = each.value.name
    condition_threshold {
      filter          = each.value.filter
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
      trigger {
        count = 1
      }
    }
  }
  documentation {
    content   = "See docs/runbooks/kill-switch.md (degradation) and docs/runbooks/deploy.md (rollback)."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "ratio" {
  for_each              = local.ratio_alerts
  display_name          = "[${var.env}] ${each.value.name}"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = each.key == "api_errors" ? "ERROR" : "WARNING"

  conditions {
    display_name = each.value.name
    condition_threshold {
      filter             = each.value.numerator
      denominator_filter = each.value.denominator
      comparison         = "COMPARISON_GT"
      threshold_value    = each.value.threshold
      duration           = each.value.duration
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }
  documentation {
    content   = "See docs/runbooks/kill-switch.md and docs/runbooks/deploy.md."
    mime_type = "text/markdown"
  }
}

# ── Log-based signals: scheduled jobs (T096, T097) and client crashes ─────

resource "google_logging_metric" "job_alert" {
  for_each = {
    spend_spike     = "${local.jobs} AND jsonPayload.message=\"spend\" AND jsonPayload.alert=true"
    reconcile_drift = "${local.jobs} AND jsonPayload.message=\"reconcile\" AND jsonPayload.status=\"drift\""
    client_crash    = "${local.run} AND jsonPayload.serviceContext.service=\"sayvox-desktop\""
  }
  name   = "${local.name}-${replace(each.key, "_", "-")}"
  filter = each.value
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "jobs" {
  for_each = {
    spend_spike     = "Daily provider spend > 2x the 7-day average"
    reconcile_drift = "Weekly audio reconciliation drift > 5 % vs ElevenLabs"
  }
  display_name          = "[${var.env}] ${each.value}"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "WARNING"

  conditions {
    display_name = each.value
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.job_alert[each.key].name}\" AND resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  alert_strategy {
    auto_close = "86400s"
  }
  documentation {
    content   = "Check the job log line in Cloud Logging, then docs/runbooks/kill-switch.md (cost section)."
    mime_type = "text/markdown"
  }
}

# Any job that fails (migrations, checks) is worth a look.
resource "google_monitoring_alert_policy" "job_failed" {
  display_name          = "[${var.env}] Cloud Run job failed"
  combiner              = "OR"
  notification_channels = local.channels
  severity              = "WARNING"
  conditions {
    display_name = "Failed job executions"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/job/completed_execution_count\" AND resource.type=\"cloud_run_job\" AND metric.labels.result=\"failed\" AND resource.labels.job_name=starts_with(\"${local.name}-\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

# "Any new crash type" (section 16) is Error Reporting's own new-error notification: turn it
# on in the console (Error Reporting -> Configure notifications) for the same email
# channel. Terraform cannot manage that setting.
