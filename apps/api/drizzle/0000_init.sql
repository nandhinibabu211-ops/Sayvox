CREATE TYPE "public"."insert_mode" AS ENUM('auto', 'review');--> statement-breakpoint
CREATE TYPE "public"."mode" AS ENUM('dictation', 'prompt', 'email');--> statement-breakpoint
CREATE TYPE "public"."preset" AS ENUM('fastest', 'balanced', 'cheapest');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('started', 'completed', 'raw_fallback', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'past_due', 'cancelled', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TABLE "billing_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE "dictionary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"term" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dictionary_terms_len" CHECK (char_length("dictionary_terms"."term") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"monthly_audio_minutes" integer NOT NULL,
	"daily_cap_minutes" integer NOT NULL,
	"allowed_presets" "preset"[] NOT NULL,
	"dictionary_limit" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"mode" "mode",
	"target_app" text,
	"audio_seconds" numeric(8, 2),
	"model_used" text,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"ttft_ms" integer,
	"total_ms" integer,
	"stt_commit_ms" integer,
	"release_to_insert_ms" integer,
	"status" "session_status" DEFAULT 'started' NOT NULL,
	"client_version" text,
	"region" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preset" "preset" DEFAULT 'balanced' NOT NULL,
	"default_mode" "mode" DEFAULT 'dictation' NOT NULL,
	"app_mode_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"insert_mode" "insert_mode" DEFAULT 'auto' NOT NULL,
	"language_hint" text,
	"hotkey" text DEFAULT 'Ctrl+Shift' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_overrides_is_object" CHECK (jsonb_typeof("settings"."app_mode_overrides") = 'object')
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'razorpay' NOT NULL,
	"provider_sub_id" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_end" timestamp with time zone,
	CONSTRAINT "subscriptions_user_id_provider_sub_id_pk" PRIMARY KEY("user_id","provider_sub_id"),
	CONSTRAINT "subscriptions_provider_sub_id_unique" UNIQUE("provider_sub_id")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"audio_seconds" numeric(10, 2) DEFAULT '0' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"llm_cost_usd" numeric(10, 5) DEFAULT '0' NOT NULL,
	"stt_cost_usd" numeric(10, 5) DEFAULT '0' NOT NULL,
	CONSTRAINT "usage_daily_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"auth_provider_id" text NOT NULL,
	"plan_id" text DEFAULT 'free' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"region" text,
	"consented_at" timestamp with time zone,
	"terms_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_auth_provider_id_unique" UNIQUE("auth_provider_id")
);
--> statement-breakpoint
ALTER TABLE "dictionary_terms" ADD CONSTRAINT "dictionary_terms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dictionary_terms_user_idx" ON "dictionary_terms" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dictionary_terms_user_term_uq" ON "dictionary_terms" USING btree ("user_id",lower("term"));--> statement-breakpoint
CREATE INDEX "sessions_user_started_idx" ON "sessions" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_started_sweep_idx" ON "sessions" USING btree ("started_at") WHERE "sessions"."status" = 'started';