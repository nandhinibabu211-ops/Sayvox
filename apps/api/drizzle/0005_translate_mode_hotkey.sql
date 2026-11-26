ALTER TYPE "public"."mode" ADD VALUE 'translate';--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "translate_hotkey" text DEFAULT 'Ctrl+Alt';