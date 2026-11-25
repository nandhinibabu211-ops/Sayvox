variable "project_id" {
  type    = string
  default = "sayvox-app-2026"
}

variable "region" {
  type    = string
  default = "us-east4"
}

variable "env" {
  type = string
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "alert_email" {
  description = "Where alerts go. Passed on the command line, never committed."
  type        = string
  sensitive   = true
}

variable "billing_account" {
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX) for the budget. Empty = no budget (set it in prod)."
  type        = string
  default     = ""
}

variable "monthly_budget" {
  description = "Google Cloud monthly budget in the billing account currency."
  type        = number
  default     = 5000
}

variable "budget_currency" {
  description = "Must match the billing account currency."
  type        = string
  default     = "INR"
}

variable "app_metric_alerts" {
  description = "Create alerts on the API's own metrics (latency, fallback, Scribe reconnects). Needs real traffic first."
  type        = bool
  default     = true
}

variable "events_retention_days" {
  description = "How long text-free product events are kept in BigQuery."
  type        = number
  default     = 400
}
