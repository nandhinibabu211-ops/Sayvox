variable "project_id" {
  type    = string
  default = "sayvox-app-2026"
}

variable "region" {
  description = "ADR-006: close to ElevenLabs and the LLM endpoints."
  type        = string
  default     = "us-east4"
}

variable "env" {
  description = "staging or prod. Names every resource, so both can share one project."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "github_repo" {
  description = "owner/name allowed to deploy through Workload Identity Federation."
  type        = string
}

variable "wif_pool_id" {
  description = "Workload Identity pool created by infra/downloads (shared with releases)."
  type        = string
  default     = "github"
}

variable "min_instances" {
  description = "ADR-006: 2 in prod for latency; 0 in staging to save money."
  type        = number
  default     = 0
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "db_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "db_high_availability" {
  type    = bool
  default = false
}

variable "redis_tier" {
  description = "BASIC (staging) or STANDARD_HA (prod)."
  type        = string
  default     = "BASIC"
}

variable "billing_enabled" {
  description = "Mount the Razorpay secrets. Add their versions in Secret Manager first."
  type        = bool
  default     = false
}

variable "razorpay_plan_ids" {
  description = "RAZORPAY_PLAN_IDS JSON, e.g. {\"pro\":\"plan_XXXX\"}. Not secret."
  type        = string
  default     = "{}"
}

variable "otel_collector_image" {
  description = "Google-built OpenTelemetry Collector for the Cloud Run sidecar. Check the latest tag in the Cloud Run 'OpenTelemetry sidecar' guide before applying."
  type        = string
  default     = "us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.138.0"
}

variable "domain" {
  description = "API domain for the HTTPS load balancer + Cloud Armor (edge.tf). Empty = no load balancer; clients use the run.app URL (ADR-009)."
  type        = string
  default     = ""
}

variable "lb_only_ingress" {
  description = "Accept traffic only through the load balancer (closes the run.app URL). Needs `domain`."
  type        = bool
  default     = false
}

variable "rate_limit_per_minute" {
  description = "Cloud Armor per-IP request limit (edge.tf). Offices behind one NAT share it, so keep it generous; per-user limits live in the API (Redis)."
  type        = number
  default     = 600
}

variable "waf_preview" {
  description = "Run the WAF rules in preview (log only). Turn off after a week of clean logs."
  type        = bool
  default     = true
}
