variable "project_id" {
  type    = string
  default = "sayvox-app-2026"
}

variable "region" {
  type    = string
  default = "us-east4"
}

variable "bucket_name" {
  description = "Must match RELEASE_BUCKET in GitHub and the updater endpoint in tauri.conf.json."
  type        = string
  default     = "sayvox-app-2026-releases"
}

variable "bucket_location" {
  description = "Multi-region so downloads are fast in India and elsewhere."
  type        = string
  default     = "ASIA"
}

variable "github_repo" {
  description = "owner/name of the repository whose workflows may upload releases."
  type        = string
}

variable "cdn_domain" {
  description = "Domain for Cloud CDN (e.g. dl.example.com). Empty = no CDN; use storage.googleapis.com (ADR-009)."
  type        = string
  default     = ""
}
