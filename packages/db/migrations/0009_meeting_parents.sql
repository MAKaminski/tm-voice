-- A row in recording, transcript and consent_event now has two possible parents: the dial path
-- (call / contact) or the Discord capture path (meeting / speaker_track). Drizzle cannot express
-- "exactly one of these", so the invariant is a CHECK here. Without it a NULL on both sides would
-- produce an orphan that neither retention.sweep nor the consent ledger could ever account for.
-- Everything is qualified to the "agents" schema so it can never bind to a table in ops or public.
ALTER TABLE "agents"."recording" ADD CONSTRAINT recording_one_parent CHECK (
  (call_id IS NOT NULL)::int + (speaker_track_id IS NOT NULL)::int = 1
);
--> statement-breakpoint
-- meeting_id on a recording is a denormalised convenience for retention queries; it must agree
-- with the track's meeting, and must be absent on a dial-path recording.
ALTER TABLE "agents"."recording" ADD CONSTRAINT recording_meeting_matches_track CHECK (
  (speaker_track_id IS NULL AND meeting_id IS NULL) OR (speaker_track_id IS NOT NULL AND meeting_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agents"."transcript" ADD CONSTRAINT transcript_one_parent CHECK (
  (call_id IS NOT NULL)::int + (meeting_id IS NOT NULL)::int = 1
);
--> statement-breakpoint
-- A consent_event records a notice given to someone: a contact reached by phone, or the members of
-- a Discord channel at the moment the bot joined. Never neither.
ALTER TABLE "agents"."consent_event" ADD CONSTRAINT consent_event_one_subject CHECK (
  (contact_id IS NOT NULL)::int + (meeting_id IS NOT NULL)::int = 1
);
