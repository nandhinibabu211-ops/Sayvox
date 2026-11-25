# ── Edge: HTTPS load balancer + Cloud Armor WAF + per-IP rate limit (T095) ─
# Needs a domain (ADR-009: none yet), so everything here is created only when
# `domain` is set. Then point the domain's A record at the `edge_ip` output, wait for the
# managed certificate and ship a desktop release whose API_BASE_URL is https://<domain>.
# Once old clients are forced past it (minClientVersion), set lb_only_ingress = true so the
# run.app URL no longer bypasses Cloud Armor (docs/runbooks/deploy.md).

locals {
  edge = var.domain != "" ? 1 : 0

  # Speech text travels in these request bodies. A developer dictating "drop the users
  # table where..." must not be blocked by a SQL-injection signature, and the API never
  # interprets this text, so the body-matching WAF rules skip these paths.
  free_text_paths = "request.path.startsWith('/v1/rewrite') || request.path.startsWith('/v1/dictionary')"
  waf_rules = {
    1000 = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1}) && !(${local.free_text_paths})"
    1010 = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1}) && !(${local.free_text_paths})"
    1020 = "evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})"
    1030 = "evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1}) && !(${local.free_text_paths})"
    1040 = "evaluatePreconfiguredWaf('scannerdetection-v33-stable', {'sensitivity': 1})"
    1050 = "evaluatePreconfiguredWaf('protocolattack-v33-stable', {'sensitivity': 1})"
    1060 = "evaluatePreconfiguredWaf('methodenforcement-v33-stable', {'sensitivity': 1})"
  }
}

resource "google_compute_security_policy" "api" {
  count       = local.edge
  name        = "${local.name}-api"
  description = "Sayvox API: OWASP rules + per-IP rate limit"

  advanced_options_config {
    json_parsing = "STANDARD"
    log_level    = "NORMAL"
  }

  dynamic "rule" {
    for_each = local.waf_rules
    content {
      priority = rule.key
      action   = "deny(403)"
      preview  = var.waf_preview
      match {
        expr {
          expression = rule.value
        }
      }
    }
  }

  # Per-IP throttle. Per-user limits (session starts, rewrites) are enforced in the API
  # with Redis; this only stops floods before they reach Cloud Run.
  rule {
    priority = 2000
    action   = "throttle"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = var.rate_limit_per_minute
        interval_sec = 60
      }
    }
  }

  rule {
    priority = 2147483647
    action   = "allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "default allow"
  }
}

resource "google_compute_region_network_endpoint_group" "api" {
  count                 = local.edge
  name                  = "${local.name}-api"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_backend_service" "api" {
  count                 = local.edge
  name                  = "${local.name}-api"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.api[0].id
  log_config {
    enable      = true
    sample_rate = 0.1
  }
  backend {
    group = google_compute_region_network_endpoint_group.api[0].id
  }
}

resource "google_compute_url_map" "api" {
  count           = local.edge
  name            = "${local.name}-api"
  default_service = google_compute_backend_service.api[0].id
}

resource "google_compute_managed_ssl_certificate" "api" {
  count = local.edge
  name  = "${local.name}-api"
  managed {
    domains = [var.domain]
  }
}

resource "google_compute_target_https_proxy" "api" {
  count            = local.edge
  name             = "${local.name}-api"
  url_map          = google_compute_url_map.api[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.api[0].id]
}

resource "google_compute_global_address" "edge" {
  count = local.edge
  name  = "${local.name}-api-edge"
}

resource "google_compute_global_forwarding_rule" "api" {
  count                 = local.edge
  name                  = "${local.name}-api"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.api[0].id
  ip_address            = google_compute_global_address.edge[0].address
  port_range            = "443"
}
