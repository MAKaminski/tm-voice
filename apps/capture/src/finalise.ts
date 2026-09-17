import type { Adapters } from "@tm/adapters";
import type { Producer } from "@tm/api";
import { type AnyDb, consentEvent, meeting, recording, speakerTrack } from "@tm/db";
import { idempotencyKey, logger } from "@tm/shared";
import { eq } from "drizzle-orm";
import { RECORDING_NOTICE } from "./notice.js";
import type { Member } from "./watch.js";
import { trackKey } from "./watch.js";

export interface Deps { db: AnyDb; adapters: Adapters; producer: Producer }

export interface StartInput {
  sessionId: string;
  guildId: string;
  channelId: string;
  startedAt: Date;
  members: readonly Member[];
}

/**
 * Open a meeting. The notice is posted BEFORE the row exists and before a single Opus packet is
 * retained: if the post fails the whole start fails and nothing is recorded, which is the only
 * ordering that makes the notice a precondition rather than a courtesy.
 *
 * The meeting row is written here rather than at finalise so the consent_event has something to
 * reference at the moment consent is actually given, and so a process that dies mid-meeting leaves
 * a visible `pending` row instead of no evidence that recording ever happened.
 *
 * Idempotent on session_id, which is minted once per join.
 */
export async function startMeeting(deps: Deps, input: StartInput): Promise<{ meetingId: string; created: boolean }> {
  const { db, adapters } = deps;

  const [existing] = await db.select().from(meeting).where(eq(meeting.sessionId, input.sessionId)).limit(1);
  if (existing) return { meetingId: existing.id, created: false };

  const notice = await adapters.discord.postChannelMessage({ channel_id: input.channelId, content: RECORDING_NOTICE });

  const meetingId = await db.transaction(async (tx) => {
    const [m] = await tx.insert(meeting).values({
      discordGuildId: input.guildId,
      discordChannelId: input.channelId,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      participantCount: input.members.filter((x) => !x.bot).length,
      transcriptionState: "pending",
    }).returning();
    if (!m) throw new Error("meeting insert returned no row");

    // Append-only (rule 4). The artifact holds the notice verbatim, the id of the message that
    // carried it, and who was in the room to read it — the three things a later question about
    // this recording would actually ask.
    await tx.insert(consentEvent).values({
      meetingId: m.id,
      eventType: "grant",
      channel: "discord",
      occurredAt: input.startedAt,
      captureArtifact: {
        notice: RECORDING_NOTICE,
        notice_message_id: notice.id,
        discord_guild_id: input.guildId,
        discord_channel_id: input.channelId,
        session_id: input.sessionId,
        members_present: input.members.filter((x) => !x.bot).map((x) => x.id),
      },
    });
    return m.id;
  });

  logger.info({ session_id: input.sessionId, meeting_id: meetingId, channel_id: input.channelId }, "recording started; notice posted and consent recorded");
  return { meetingId, created: true };
}

/** One participant's audio, already transcoded, ready to persist. */
export interface FinishedTrack {
  discordUserId: string;
  displayName: string | null;
  /** 16 kbps Ogg Opus. */
  audio: Uint8Array;
  durationSec: number;
}

export interface FinaliseInput {
  sessionId: string;
  endedAt: Date;
  /** Distinct non-bot members seen at any point, not the count at the end. */
  participantCount: number;
  tracks: FinishedTrack[];
}

/** retain_until is created + 5 years exactly; the DB CHECK recording_retain_5y refuses less. */
export function retainUntil(from: Date): string {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() + 5);
  return d.toISOString().slice(0, 10);
}

/**
 * Close a meeting and hand it to the pipeline. Ordering is deliberate:
 *
 *   1. upload every track to R2
 *   2. one transaction writing speaker_track + recording and closing the meeting
 *   3. enqueue exactly one meeting.postcall job
 *
 * Audio first because an object with no row is inert — the retention sweeper ignores it and it
 * costs pennies — whereas a row pointing at an object that was never uploaded makes the
 * transcription step fail forever on a key that will never exist. Enqueue last, and outside the
 * transaction, because a job that arrives before its rows are committed finds nothing and burns
 * its five attempts.
 *
 * Idempotent on meeting.ended_at: a session already closed is not re-uploaded and not re-queued.
 */
export async function finaliseMeeting(deps: Deps, input: FinaliseInput): Promise<{ meetingId: string; closed: boolean; tracks: number }> {
  const { db, adapters, producer } = deps;

  const [m] = await db.select().from(meeting).where(eq(meeting.sessionId, input.sessionId)).limit(1);
  if (!m) throw new Error(`finalise called for an unknown session: ${input.sessionId}`);
  if (m.endedAt) {
    logger.info({ session_id: input.sessionId, meeting_id: m.id }, "meeting already finalised; not re-uploading");
    return { meetingId: m.id, closed: false, tracks: 0 };
  }

  const uploaded: (FinishedTrack & { key: string; byteSize: number })[] = [];
  for (const t of input.tracks) {
    const key = trackKey(input.sessionId, t.discordUserId);
    await adapters.r2.putObject(key, t.audio, "audio/ogg");
    uploaded.push({ ...t, key, byteSize: t.audio.byteLength });
  }

  await db.transaction(async (tx) => {
    for (const u of uploaded) {
      const [track] = await tx.insert(speakerTrack).values({
        meetingId: m.id,
        discordUserId: u.discordUserId,
        displayName: u.displayName,
        r2Key: u.key,
        durationSec: Math.round(u.durationSec),
        byteSize: u.byteSize,
        transcriptionState: "pending",
      }).returning();
      if (!track) throw new Error("speaker_track insert returned no row");
      await tx.insert(recording).values({
        meetingId: m.id,
        speakerTrackId: track.id,
        r2Key: u.key,
        retainUntil: retainUntil(input.endedAt),
      });
    }
    await tx.update(meeting).set({
      endedAt: input.endedAt,
      participantCount: Math.max(m.participantCount, input.participantCount),
      updatedAt: new Date(),
    }).where(eq(meeting.id, m.id));
  });

  await producer.enqueue("meeting", "postcall", {
    entity_id: m.id,
    idempotency_key: idempotencyKey("meeting", input.sessionId),
    attempt: 0,
    enqueued_at: new Date().toISOString(),
    session_id: input.sessionId,
  });

  logger.info(
    { session_id: input.sessionId, meeting_id: m.id, tracks: uploaded.length, participants: input.participantCount },
    "meeting finalised and queued",
  );
  return { meetingId: m.id, closed: true, tracks: uploaded.length };
}
