ALTER TABLE "stations" ADD COLUMN "camera_error" text;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "last_error_at" timestamp with time zone;