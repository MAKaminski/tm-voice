import { REQUEST_BYTE_LIMIT, type Segment } from "@tm/adapters";
import { meeting, speakerTrack, transcript } from "@tm/db";
import { logger } from "@tm/shared";
import { eq } from "drizzle-orm";
import type { Processor } from "../context.js";

/** What apps/capture enqueues on meeting.postcall. */
export type MeetingPostcallPayload = { session_id: string };

/** One line of the merged transcript. Speaker-attributed and absolutely timed. */
export interface MeetingTurn {
  speaker: string;
  discord_user_id: string;
  at_sec: number;
  text: string;
}

/**
 * Split a track into pieces that fit one STT request.
 *
 * Ogg pages cannot be cut at an arbitrary byte offset and still decode, so this splits on page
 * boundaries — every Ogg page starts with the "OggS" capture pattern — and each piece is a valid
 * standalone-ish stream from the provider's point of view. The offset returned with each chunk is
 * what makes the segments come back on the meeting's clock rather than the chunk's.
 *
 * At 16 kbps a 25 MB request holds about 3.6 hours of one person talking, so in practice this
 * returns a single chunk and exists for the meeting that does not.
 */
export function chunkOgg(audio: Uint8Array, limit = REQUEST_BYTE_LIMIT): Uint8Array[] {
  if (audio.byteLength <= limit) return [audio.slice()];
  const buf = Buffer.from(audio);
  const starts: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53) starts.push(i);
  }
  if (starts.length === 0) return [audio.slice()]; // not Ogg; let the adapter reject it rather than guess

  const chunks: Uint8Array[] = [];
  let begin = 0;
  for (let i = 1; i < starts.length; i++) {
    const nextEnd = starts[i]!;
    if (nextEnd - begin > limit) {
      const cut = starts[i - 1]!;
      // One page on its own is already over the limit: nothing can be done here, so emit it and let
      // the adapter's own size check report it.
      chunks.push(audio.slice(begin, cut === begin ? nextEnd : cut));
      begin = cut === begin ? nextEnd : cut;
    }
  }
  chunks.push(audio.slice(begin));
  return chunks.filter((c) => c.byteLength > 0);
}

/**
 * Merge every track into one speaker-attributed transcript ordered by timestamp.
 *
 * Ties are broken by speaker id, not by whichever track happened to be read first: two people
 * starting at the same second must produce the same transcript on a replay, or the extraction step
 * sees different input and the idempotency guarantee stops at the database.
 */
export function mergeTurns(tracks: readonly { discordUserId: string; displayName: string | null; segments: Segment[] }[]): MeetingTurn[] {
  const turns = tracks.flatMap((t) =>
    t.segments.map((s) => ({
      speaker: t.displayName ?? t.discordUserId,
      discord_user_id: t.discordUserId,
      at_sec: s.start_sec,
      text: s.text,
    })),
  );
  return turns.sort((a, b) => a.at_sec - b.at_sec || a.discord_user_id.localeCompare(b.discord_user_id));
}

/**
 * Transcribe every speaker track and write one merged transcript.
 *
 * Idempotent at two levels, which is the point of speaker_track carrying its own state:
 *   - a meeting already `transcribed` returns without touching anything
 *   - within a meeting, only tracks not yet `transcribed` are sent to the provider
 * so a crash part-way through a five-person meeting resumes on the two tracks left rather than
 * paying to transcribe the three that are done and re-filing their commitments.
 */
export const meetingPostcall: Processor<MeetingPostcallPayload> = async (ctx, p) => {
  const [m] = await ctx.db.select().from(meeting).where(eq(meeting.sessionId, p.session_id)).limit(1);
  if (!m) {
    logger.warn({ session_id: p.session_id }, "meeting.postcall for a session we did not capture; ignored");
    return { skipped: "unknown_meeting" };
  }
  if (m.transcriptionState === "transcribed") {
    return { skipped: "already_processed", meeting_id: m.id };
  }

  const tracks = await ctx.db.select().from(speakerTrack).where(eq(speakerTrack.meetingId, m.id));
  if (tracks.length === 0) {
    // A meeting where nobody spoke is finished, not broken: mark it and stop before extraction.
    await ctx.db.update(meeting).set({ transcriptionState: "transcribed", updatedAt: new Date() }).where(eq(meeting.id, m.id));
    logger.info({ session_id: p.session_id, meeting_id: m.id }, "meeting had no speaker tracks; nothing to transcribe");
    return { meeting_id: m.id, tracks: 0, turns: 0 };
  }

  await ctx.db.update(meeting).set({ transcriptionState: "transcribing", updatedAt: new Date() }).where(eq(meeting.id, m.id));

  let transcribedNow = 0;
  for (const t of tracks) {
    if (t.transcriptionState === "transcribed") continue;
    try {
      await ctx.db.update(speakerTrack).set({ transcriptionState: "transcribing", updatedAt: new Date() }).where(eq(speakerTrack.id, t.id));
      const audio = await ctx.adapters.r2.getObject(t.r2Key);

      const segments: Segment[] = [];
      let offsetSec = 0;
      for (const chunk of chunkOgg(audio)) {
        const r = await ctx.adapters.stt_batch.transcribeFile({
          key: t.r2Key, audio: chunk, content_type: "audio/ogg", offset_sec: offsetSec,
        });
        segments.push(...r.segments);
        // Continue the meeting clock from where this chunk ended, so a second chunk's segments do
        // not all land back at zero and scramble the merge order.
        offsetSec = segments.at(-1)?.end_sec ?? offsetSec;
      }

      await ctx.db.update(speakerTrack).set({ segments, transcriptionState: "transcribed", updatedAt: new Date() }).where(eq(speakerTrack.id, t.id));
      transcribedNow += 1;
    } catch (e) {
      // Mark this track failed and re-raise: BullMQ retries the job, and the tracks that already
      // succeeded are skipped on the way back through.
      await ctx.db.update(speakerTrack).set({ transcriptionState: "failed", updatedAt: new Date() }).where(eq(speakerTrack.id, t.id));
      await ctx.db.update(meeting).set({ transcriptionState: "failed", updatedAt: new Date() }).where(eq(meeting.id, m.id));
      logger.error({ session_id: p.session_id, track_id: t.id, r2_key: t.r2Key, err: (e as Error).message }, "speaker track transcription failed");
      throw e;
    }
  }

  const fresh = await ctx.db.select().from(speakerTrack).where(eq(speakerTrack.meetingId, m.id));
  const turns = mergeTurns(fresh.map((t) => ({
    discordUserId: t.discordUserId, displayName: t.displayName, segments: (t.segments ?? []) as Segment[],
  })));

  await ctx.db.transaction(async (tx) => {
    // One transcript per meeting. A retry that got past the per-track guard must not leave two.
    await tx.delete(transcript).where(eq(transcript.meetingId, m.id));
    await tx.insert(transcript).values({ meetingId: m.id, turns, summary: null, structured: null });
    await tx.update(meeting).set({ transcriptionState: "transcribed", updatedAt: new Date() }).where(eq(meeting.id, m.id));
  });

  logger.info(
    { session_id: p.session_id, meeting_id: m.id, tracks: tracks.length, transcribed_now: transcribedNow, turns: turns.length },
    "meeting transcribed and merged",
  );
  return { meeting_id: m.id, tracks: tracks.length, transcribed_now: transcribedNow, turns: turns.length };
};
