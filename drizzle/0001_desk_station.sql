CREATE TABLE "stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Desk station' NOT NULL,
	"token_hash" text NOT NULL,
	"pair_code" text,
	"approved_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"active_session_id" integer,
	"started_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"capture_requested" boolean DEFAULT false NOT NULL,
	"busy_since" timestamp with time zone,
	"last_change_at" timestamp with time zone,
	"nudged_at" timestamp with time zone,
	"pin_failures" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "tutor_sessions" ADD COLUMN "desk" jsonb;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_active_session_id_tutor_sessions_id_fk" FOREIGN KEY ("active_session_id") REFERENCES "public"."tutor_sessions"("id") ON DELETE set null ON UPDATE no action;