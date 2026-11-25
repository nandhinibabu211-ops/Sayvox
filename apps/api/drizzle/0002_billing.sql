ALTER TYPE "public"."subscription_status" ADD VALUE 'halted';--> statement-breakpoint
-- Backfill existing rows (any subscription before billing could only be for "pro"), then
-- drop the default so new rows must say which plan they grant.
ALTER TABLE "subscriptions" ADD COLUMN "plan_id" text NOT NULL DEFAULT 'pro';--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "plan_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;