# Google Cloud budget alert (T097). Provider spend caps (ElevenLabs, OpenRouter) are set in
# those dashboards, not here: see docs/runbooks/kill-switch.md "Spend caps".

resource "google_billing_budget" "monthly" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "Sayvox Google Cloud monthly"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.monthly_budget)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = local.channels
    disable_default_iam_recipients   = false
  }
  depends_on = [google_project_service.apis]
}

data "google_project" "this" {}
