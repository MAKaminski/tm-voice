CREATE SCHEMA IF NOT EXISTS "agents";
--> statement-breakpoint
CREATE TYPE "agents"."account_type" AS ENUM('property_mgr', 'homeowner');--> statement-breakpoint
CREATE TYPE "agents"."booking_status" AS ENUM('pending_review', 'approved', 'rejected', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "agents"."call_task_status" AS ENUM('queued', 'claimed', 'dialed', 'blocked', 'done');--> statement-breakpoint
CREATE TYPE "agents"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "agents"."consent_event_type" AS ENUM('grant', 'revoke');--> statement-breakpoint
CREATE TYPE "agents"."disposition" AS ENUM('dry_run', 'booked', 'callback', 'not_interested', 'opt_out', 'voicemail', 'no_answer', 'busy', 'failed', 'wrong_number');--> statement-breakpoint
CREATE TYPE "agents"."gate_result" AS ENUM('pass', 'surface', 'suppressed', 'dnc', 'window', 'did_cap', 'attempts');--> statement-breakpoint
CREATE TYPE "agents"."line_type" AS ENUM('wireless', 'landline', 'voip', 'unknown');--> statement-breakpoint
CREATE TYPE "agents"."schedule_block_source" AS ENUM('hcp_job', 'pto', 'window');--> statement-breakpoint
CREATE TABLE "agents"."account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "agents"."account_type" DEFAULT 'property_mgr' NOT NULL,
	"apollo_account_id" text,
	"hcp_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid,
	"contact_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"service_address_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"arrival_window_min" integer DEFAULT 120 NOT NULL,
	"hcp_job_id" text,
	"status" "agents"."booking_status" DEFAULT 'pending_review' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."calendar_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"graph_event_id" text,
	"rsvp_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_task_id" uuid NOT NULL,
	"did_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"disposition" "agents"."disposition",
	"apollo_phone_call_id" text,
	"vapi_call_id" text,
	"telnyx_call_control_id" text,
	"cost_usd" numeric(8, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."call_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"earliest_dial_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_no" integer DEFAULT 0 NOT NULL,
	"status" "agents"."call_task_status" DEFAULT 'queued' NOT NULL,
	"gate_result" "agents"."gate_result",
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"script_version_id" uuid NOT NULL,
	"apollo_saved_search_id" text,
	"daily_dial_cap" integer DEFAULT 50 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"status" "agents"."campaign_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."consent_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"call_id" uuid,
	"event_type" "agents"."consent_event_type" NOT NULL,
	"channel" text NOT NULL,
	"capture_artifact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone_e164" text NOT NULL,
	"line_type" "agents"."line_type" DEFAULT 'unknown' NOT NULL,
	"state" text,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"apollo_contact_id" text,
	"dnc_federal" boolean DEFAULT false NOT NULL,
	"dnc_state" boolean DEFAULT false NOT NULL,
	"dnc_checked_at" timestamp with time zone,
	"booking_token" text DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."did" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"attestation" text DEFAULT 'A' NOT NULL,
	"daily_cap" integer DEFAULT 50 NOT NULL,
	"label_status" text DEFAULT 'unknown' NOT NULL,
	"telnyx_number_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "did_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE "agents"."email_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"template" text NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."recording" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"signed_url" text,
	"signed_url_expires_at" timestamp with time zone,
	"retain_until" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."schedule_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"technician_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"source" "agents"."schedule_block_source" NOT NULL,
	"hcp_job_id" text,
	"lat" numeric(9, 6),
	"lon" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."script_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"disclosure_line" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."service_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text,
	"state" text,
	"zip" text,
	"lat" numeric(9, 6),
	"lon" numeric(9, 6),
	"hcp_address_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"reason" text NOT NULL,
	"source_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE "agents"."technician" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hcp_employee_id" text,
	"max_jobs_per_day" integer DEFAULT 2 NOT NULL,
	"max_miles_between_jobs" integer DEFAULT 50 NOT NULL,
	"home_lat" numeric(9, 6),
	"home_lon" numeric(9, 6),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."transcript" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents"."booking" ADD CONSTRAINT "booking_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "agents"."call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."booking" ADD CONSTRAINT "booking_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "agents"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."booking" ADD CONSTRAINT "booking_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "agents"."technician"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."booking" ADD CONSTRAINT "booking_service_address_id_service_address_id_fk" FOREIGN KEY ("service_address_id") REFERENCES "agents"."service_address"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."calendar_invite" ADD CONSTRAINT "calendar_invite_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "agents"."booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."call" ADD CONSTRAINT "call_call_task_id_call_task_id_fk" FOREIGN KEY ("call_task_id") REFERENCES "agents"."call_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."call" ADD CONSTRAINT "call_did_id_did_id_fk" FOREIGN KEY ("did_id") REFERENCES "agents"."did"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."call_task" ADD CONSTRAINT "call_task_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "agents"."campaign"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."call_task" ADD CONSTRAINT "call_task_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "agents"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."campaign" ADD CONSTRAINT "campaign_script_version_id_script_version_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "agents"."script_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."consent_event" ADD CONSTRAINT "consent_event_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "agents"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."consent_event" ADD CONSTRAINT "consent_event_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "agents"."call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."contact" ADD CONSTRAINT "contact_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "agents"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."email_send" ADD CONSTRAINT "email_send_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "agents"."booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."recording" ADD CONSTRAINT "recording_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "agents"."call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."schedule_block" ADD CONSTRAINT "schedule_block_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "agents"."technician"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."service_address" ADD CONSTRAINT "service_address_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "agents"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."suppression" ADD CONSTRAINT "suppression_source_call_id_call_id_fk" FOREIGN KEY ("source_call_id") REFERENCES "agents"."call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."transcript" ADD CONSTRAINT "transcript_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "agents"."call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_idempotency_uq" ON "agents"."booking" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "call_task_claim_idx" ON "agents"."call_task" USING btree ("campaign_id","earliest_dial_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "consent_event_contact_idx" ON "agents"."consent_event" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "contact_phone_idx" ON "agents"."contact" USING btree ("phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_booking_token_uq" ON "agents"."contact" USING btree ("booking_token");--> statement-breakpoint
CREATE UNIQUE INDEX "email_send_idempotency_uq" ON "agents"."email_send" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "schedule_block_tech_start_idx" ON "agents"."schedule_block" USING btree ("technician_id","start_at");