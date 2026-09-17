import { call, recording } from "@tm/db";
import { logger } from "@tm/shared";
import { eq } from "drizzle-orm";
import type { Processor } from "../context.js";

/** What postcall.process enqueues once it knows a recording exists. */
export type RecordingPayload = { vapi_call_id: string; recording_url: string };

/**
 * Five years exactly. The DB CHECK `recording_retain_5y` refuses anything shorter, and
 * docs/COMPLIANCE.md commits to keeping the recording, the transcript and the consent record for
 * that long. Deliberately not "five years plus a margin": the sweeper deletes strictly after
 * `retain_until`, so the margin would be dead storage rather than safety.
 */
export function retainUntil(from: Date): string {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() + 5);
  return d.toISOString().slice(0, 10);
}

/** `calls/<yyyy>/<mm>/<call_id>.<ext>` — one prefix per month, so a retention sweep is one listing. */
export function recordingKey(callId: string, startedAt: Date, contentType: string): string {
  const yyyy = startedAt.getUTCFullYear();
  const mm = String(startedAt.getUTCMonth() + 1).padStart(2, "0");
  const ext = contentType.includes("mpeg") ? "mp3" : contentType.includes("ogg") ? "ogg" : "wav";
  return `calls/${yyyy}/${mm}/${callId}.${ext}`;
}

/**
 * Store a call's recording.
 *
 * A separate job rather than a step inside postcall.process, for two reasons. The disposition,
 * transcript and retry schedule are the part that must not be recomputed, and inlining this would
 * mean a transient R2 or Vapi failure re-runs all of it. And Vapi's recording URL is short-lived,
 * so this is the step most likely to need retries — which it now gets on its own, with its own
 * dead-letter entry naming the call rather than the whole post-call run.
 *
 * Idempotent on the `recording` row, not the job id, matching postcallProcess: a replay finds the
 * row and stops before spending a download.
 */
export const postcallRecording: Processor<RecordingPayload> = async (ctx, p) => {
  const [c] = await ctx.db.select().from(call).where(eq(call.vapiCallId, p.vapi_call_id)).limit(1);
  if (!c) {
    logger.warn({ vapi_call_id: p.vapi_call_id }, "recording for a call we did not place; ignored");
    return { skipped: "unknown_call" };
  }

  const [existing] = await ctx.db.select({ id: recording.id }).from(recording).where(eq(recording.callId, c.id)).limit(1);
  if (existing) return { skipped: "already_stored", recording_id: existing.id };

  const { bytes, contentType } = await ctx.adapters.vapi.downloadRecording(p.recording_url);
  const key = recordingKey(c.id, c.startedAt, contentType);
  await ctx.adapters.r2.putObject(key, bytes, contentType);

  // Audio first, row second: an object with no row is inert and cheap, whereas a row pointing at
  // an object that was never uploaded makes the retention sweep delete something that is not there
  // and reports a recording we cannot produce.
  const [row] = await ctx.db.insert(recording).values({
    callId: c.id, r2Key: key, retainUntil: retainUntil(c.startedAt),
  }).returning();

  logger.info({ call_id: c.id, recording_id: row!.id, r2_key: key, bytes: bytes.byteLength }, "call recording stored");
  return { call_id: c.id, recording_id: row!.id, r2_key: key, bytes: bytes.byteLength };
};
