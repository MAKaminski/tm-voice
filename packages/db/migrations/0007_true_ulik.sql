ALTER TABLE "agents"."call" ADD COLUMN "telnyx_hangup_cause" text;--> statement-breakpoint
ALTER TABLE "agents"."call" ADD COLUMN "telnyx_cost_usd" numeric(8, 4);