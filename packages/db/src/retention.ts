/**
 * How long a recording is kept, in one place because two services write the row and the database
 * enforces the floor.
 *
 * `agents.recording` carries `CHECK (retain_until >= created_at::date + INTERVAL '5 years')`
 * (migrations/0001_consent_immutable.sql), and docs/COMPLIANCE.md commits to keeping the recording,
 * the transcript and the consent record for that long.
 *
 * Five years exactly, deliberately not "five years plus a margin": the sweeper
 * (apps/worker/src/processors/retention.ts) deletes strictly after `retain_until`, so a margin
 * would be dead storage rather than safety.
 *
 * Measured from the later of the source event and now. Both callers previously anchored only to
 * the event — a call's `started_at`, a meeting's `ended_at` — while the CHECK anchors to
 * `created_at`. Any recording stored on a later UTC day than its event then computed a
 * `retain_until` below the floor and the insert was rejected, permanently: a retry only moves
 * `created_at` further away. Every call and meeting that straddled midnight lost its recording.
 * Taking the later of the two satisfies the CHECK by construction and never shortens the window;
 * the margin it can add is at most the storage delay.
 */
export function retainUntil(from: Date, now: Date = new Date()): string {
  const d = new Date(Math.max(from.getTime(), now.getTime()));
  d.setUTCFullYear(d.getUTCFullYear() + 5);
  return d.toISOString().slice(0, 10);
}
