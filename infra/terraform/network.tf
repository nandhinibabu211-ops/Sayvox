# Private networking: Cloud SQL and Memorystore have no public IP; Cloud Run reaches them
# through Direct VPC egress.

resource "google_compute_network" "vpc" {
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "run" {
  name                     = "${local.name}-run"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = var.env == "prod" ? "10.10.0.0/24" : "10.20.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "services" {
  name          = "${local.name}-services"
  network       = google_compute_network.vpc.id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
}

resource "google_service_networking_connection" "services" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.services.name]
}
