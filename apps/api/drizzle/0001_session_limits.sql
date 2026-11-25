ALTER TABLE "sessions" ADD COLUMN "keyterms_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "max_session_seconds" integer DEFAULT 300 NOT NULL;