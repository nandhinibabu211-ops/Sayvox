# Cheap staging (owner decision 2026-11-25: "We do not need to spend this much for staging"):
# - AlloyDB Express: serverless Postgres that pauses when idle. Created with gcloud
#   (deploy.md "Staging database"), then reached here through a Private Service Connect
#   endpoint in the Cloud Run subnet (Express has no VPC peering).
# - Redis on one e2-micro VM: free tier in us-west1/us-central1/us-east1. No external IP;
#   the image comes from mirror.gcr.io over Private Google Access. Self-managed and
#   unreplicated: fine for staging, never for prod.

# ── AlloyDB Express endpoint ─────────────────────────────────────────────

resource "google_compute_address" "alloydb_psc" {
  count        = local.alloydb && var.alloydb_psc_attachment != "" ? 1 : 0
  name         = "${local.name}-alloydb"
  region       = var.region
  subnetwork   = google_compute_subnetwork.run.id
  address_type = "INTERNAL"
}

resource "google_compute_forwarding_rule" "alloydb_psc" {
  count                 = length(google_compute_address.alloydb_psc)
  name                  = "${local.name}-alloydb"
  region                = var.region
  network               = google_compute_network.vpc.id
  ip_address            = google_compute_address.alloydb_psc[0].id
  target                = var.alloydb_psc_attachment
  load_balancing_scheme = ""
}

# ── Redis VM ─────────────────────────────────────────────────────────────

resource "google_service_account" "redis" {
  count        = local.memorystore ? 0 : 1
  account_id   = "${local.name}-redis"
  display_name = "Sayvox Redis VM (${var.env})"
}

resource "google_project_iam_member" "redis_logs" {
  count   = local.memorystore ? 0 : 1
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.redis[0].email}"
}

resource "google_compute_instance" "redis" {
  count        = local.memorystore ? 0 : 1
  name         = "${local.name}-redis"
  machine_type = "e2-micro"
  zone         = "${var.region}-b"
  tags         = ["sayvox-redis"]

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 10
      type  = "pd-standard"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.run.id
    # No access_config: no external IP.
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  service_account {
    email  = google_service_account.redis[0].email
    scopes = ["logging-write"]
  }

  metadata = {
    # Container-Optimized OS runs this cloud-init on boot. The password is in instance
    # metadata (readable by project viewers): acceptable for staging only.
    user-data = <<-EOT
      #cloud-config
      write_files:
        - path: /etc/systemd/system/redis.service
          permissions: "0644"
          content: |
            [Unit]
            Description=Redis
            Wants=network-online.target
            After=network-online.target docker.service
            [Service]
            Restart=always
            ExecStartPre=-/usr/bin/docker rm -f redis
            ExecStart=/usr/bin/docker run --name redis -p 6379:6379 mirror.gcr.io/library/redis:7-alpine redis-server --requirepass ${random_password.redis.result} --maxmemory 400mb --maxmemory-policy allkeys-lru --save ""
            ExecStop=/usr/bin/docker stop redis
      runcmd:
        - systemctl daemon-reload
        - systemctl start redis.service
    EOT
  }

  allow_stopping_for_update = true
  depends_on                = [google_project_service.apis]
}

# Only the Cloud Run subnet (services and jobs use Direct VPC egress from it) reaches Redis.
resource "google_compute_firewall" "redis" {
  count         = local.memorystore ? 0 : 1
  name          = "${local.name}-redis-from-run"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  source_ranges = [google_compute_subnetwork.run.ip_cidr_range]
  target_tags   = ["sayvox-redis"]
  allow {
    protocol = "tcp"
    ports    = ["6379"]
  }
}
