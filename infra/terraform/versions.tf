# Sayvox API on Google Cloud (T094, ADR-006): Cloud Run + Cloud SQL + Memorystore +
# Secret Manager + Artifact Registry, one state per environment.
#
#   gcloud storage buckets create gs://sayvox-app-2026-tfstate --location=us-east4 --uniform-bucket-level-access
#   terraform -chdir=infra/terraform init -backend-config="bucket=sayvox-app-2026-tfstate" -backend-config="prefix=api/staging"
#   terraform -chdir=infra/terraform apply -var-file=staging.tfvars
#
# Prod uses prefix=api/prod and prod.tfvars. See docs/runbooks/deploy.md.

terraform {
  required_version = ">= 1.6"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
