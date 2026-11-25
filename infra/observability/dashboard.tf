# One dashboard with every section 16 signal, so a release can be judged at a glance
# (docs/runbooks/release.md step 6).

locals {
  p95 = {
    alignmentPeriod    = "300s"
    perSeriesAligner   = "ALIGN_DELTA"
    crossSeriesReducer = "REDUCE_PERCENTILE_95"
  }
  p50 = merge(local.p95, { crossSeriesReducer = "REDUCE_PERCENTILE_50" })
  rate_by = { for k in ["outcome", "result", "scribe_retried", "response_code_class"] : k => {
    alignmentPeriod    = "300s"
    perSeriesAligner   = "ALIGN_RATE"
    crossSeriesReducer = "REDUCE_SUM"
    groupByFields      = ["metric.label.${k}"]
  } }
  line = {
    "Release to inserted p50 / p95 (ms) by mode" = [
      { filter = local.m.release_to_insert, agg = merge(local.p50, { groupByFields = ["metric.label.mode"] }) },
      { filter = local.m.release_to_insert, agg = merge(local.p95, { groupByFields = ["metric.label.mode"] }) },
    ]
    "Scribe commit p95 (ms)" = [
      { filter = "metric.type=\"${local.wl}/stt_commit_ms\" AND ${local.ns}", agg = local.p95 },
    ]
    "LLM time to first token p50 / p95 (ms)" = [
      { filter = local.m.llm_ttft, agg = local.p50 },
      { filter = local.m.llm_ttft, agg = local.p95 },
    ]
    "Rewrites by outcome (per s)" = [
      { filter = local.m.rewrites, agg = local.rate_by.outcome },
    ]
    "Sessions by insert result (per s)" = [
      { filter = local.m.session_ends, agg = local.rate_by.result },
    ]
    "Sessions with a Scribe reconnect (per s)" = [
      { filter = local.m.session_ends, agg = local.rate_by.scribe_retried },
    ]
    "/v1/session/start p95 (ms)" = [
      { filter = local.m.session_start, agg = local.p95 },
    ]
    "API requests by status class (per s)" = [
      { filter = local.m.requests, agg = local.rate_by.response_code_class },
    ]
    "Client crashes (per hour)" = [
      {
        filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.job_alert["client_crash"].name}\""
        agg    = { alignmentPeriod = "3600s", perSeriesAligner = "ALIGN_SUM", crossSeriesReducer = "REDUCE_SUM" }
      },
    ]
  }

  tiles = [for i, name in keys(local.line) : {
    xPos   = (i % 2) * 24
    yPos   = floor(i / 2) * 16
    width  = 24
    height = 16
    widget = {
      title = name
      xyChart = {
        dataSets = [for d in local.line[name] : {
          plotType = "LINE"
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter      = d.filter
              aggregation = d.agg
            }
          }
        }]
      }
    }
  }]
}

resource "google_monitoring_dashboard" "sayvox" {
  dashboard_json = jsonencode({
    displayName  = "Sayvox (${var.env})"
    mosaicLayout = { columns = 48, tiles = local.tiles }
  })
}
