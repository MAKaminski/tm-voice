-- CONSENT_EVENT is append-only: reject UPDATE and DELETE at the database, not the app.
CREATE OR REPLACE FUNCTION consent_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_event is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS consent_event_immutable_trg ON consent_event;
--> statement-breakpoint
CREATE TRIGGER consent_event_immutable_trg
  BEFORE UPDATE OR DELETE ON consent_event
  FOR EACH ROW EXECUTE FUNCTION consent_event_immutable();
--> statement-breakpoint
-- RECORDING.retain_until must be at least 5 years after creation; retention sweeper never deletes before it.
ALTER TABLE recording ADD CONSTRAINT recording_retain_5y CHECK (retain_until >= (created_at::date + INTERVAL '5 years'));
