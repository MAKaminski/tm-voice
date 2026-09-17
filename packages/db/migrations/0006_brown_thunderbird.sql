CREATE TYPE "agents"."transcription_state" AS ENUM('pending', 'transcribing', 'transcribed', 'failed');--> statement-breakpoint
CREATE TABLE "agents"."meeting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_guild_id" text NOT NULL,
	"discord_channel_id" text NOT NULL,
	"session_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"transcription_state" "agents"."transcription_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents"."meeting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agents"."speaker_track" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"discord_user_id" text NOT NULL,
	"display_name" text,
	"r2_key" text NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"transcription_state" "agents"."transcription_state" DEFAULT 'pending' NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents"."speaker_track" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents"."consent_event" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents"."recording" ALTER COLUMN "call_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents"."transcript" ALTER COLUMN "call_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents"."consent_event" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "agents"."recording" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "agents"."recording" ADD COLUMN "speaker_track_id" uuid;--> statement-breakpoint
ALTER TABLE "agents"."transcript" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "agents"."speaker_track" ADD CONSTRAINT "speaker_track_meeting_id_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "agents"."meeting"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_session_uq" ON "agents"."meeting" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "meeting_channel_idx" ON "agents"."meeting" USING btree ("discord_channel_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "speaker_track_meeting_user_uq" ON "agents"."speaker_track" USING btree ("meeting_id","discord_user_id");--> statement-breakpoint
ALTER TABLE "agents"."consent_event" ADD CONSTRAINT "consent_event_meeting_id_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "agents"."meeting"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."recording" ADD CONSTRAINT "recording_meeting_id_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "agents"."meeting"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."recording" ADD CONSTRAINT "recording_speaker_track_id_speaker_track_id_fk" FOREIGN KEY ("speaker_track_id") REFERENCES "agents"."speaker_track"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."transcript" ADD CONSTRAINT "transcript_meeting_id_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "agents"."meeting"("id") ON DELETE no action ON UPDATE no action;