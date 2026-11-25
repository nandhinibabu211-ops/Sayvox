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

variable "database" {
  description = "cloudsql (prod) or alloydb_express (cheap serverless staging, created with gcloud: deploy.md)."
  type        = string
  default     = "cloudsql"
  validation {
    condition     = contains(["cloudsql", "alloydb_express"], var.database)
    error_message = "database must be cloudsql or alloydb_express."
  }
}

variable "alloydb_psc_attachment" {
  description = "Service attachment of the AlloyDB Express instance (gcloud ... instances describe). Empty until it exists."
  type        = string
  default     = ""
}

variable "redis" {
  description = "memorystore (prod) or vm (free-tier e2-micro, staging only)."
  type        = string
  default     = "memorystore"
  validation {
    condition     = contains(["memorystore", "vm"], var.redis)
    error_message = "redis must be memorystore or vm."
  }
}

variable "db_connect_timeout_ms" {
  description = "Postgres connect timeout. AlloyDB Express wakes from pause in ~20 s."
  type        = number
  default     = 5000
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

variable "provider_keys_ready" {
  description = "Mount the ElevenLabs/OpenRouter secrets. Add their versions first; false runs the API without them (dictation answers 503)."
  type        = bool
  default     = true
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

variable "initial_image" {
  description = "Image for the first apply only (deploy.yml manages it afterwards)."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "otel_collector_image" {
  description = "Google-built OpenTelemetry Collector for the Cloud Run sidecar (tag checked 2026-11-25 against the public registry)."
  type        = string
  default     = "us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.165.1"
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
