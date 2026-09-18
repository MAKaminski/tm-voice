import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { consentEvent, meeting, recording, retainUntil, speakerTrack } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Deps, finaliseMeeting, startMeeting } from "../src/finalise.js";
import { mintSessionId } from "../src/watch.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123", WATCH_CHANNEL_IDS: "chan-a" });

let t: Awaited<ReturnType<typeof createTestDb>>;
let deps: Deps;
const enqueued: { queue: string; name: string; payload: Record<string, unknown> }[] = [];

const startedAt = new Date("2026-09-17T14:00:00Z");
const endedAt = new Date("2026-09-17T15:00:00Z");
const sessionId = mintSessionId("g1", "chan-a", startedAt);
const members = [{ id: "u1", bot: false }, { id: "u2", bot: false }, { id: "bot", bot: true }];

const track = (userId: string, bytes: number) => ({
  discordUserId: userId, displayName: `name-${userId}`, audio: new Uint8Array(bytes), durationSec: 120.4,
});

beforeAll(async () => {
  t = await createTestDb();
  deps = {
    db: t.db,
    adapters: createAdapters(cfg),
    producer: createProducer(undefined, async (queue, name, payload) => { enqueued.push({ queue, name, payload }); }),
  };
});
afterAll(() => t.close());

describe("startMeeting", () => {
  it("posts the notice, opens the meeting and records consent against it", async () => {
    const r = await startMeeting(deps, { sessionId, guildId: "g1", channelId: "chan-a", startedAt, members });
    expect(r.created).toBe(true);

    const [m] = await t.db.select().from(meeting).where(eq(meeting.id, r.meetingId));
    expect(m).toMatchObject({ discordChannelId: "chan-a", participantCount: 2, transcriptionState: "pending", endedAt: null });

    const posted = deps.adapters.discord.mock?.calls.filter((c) => c.method === "postChannelMessage") ?? [];
    expect(posted).toHaveLength(1);

    const [ce] = await t.db.select().from(consentEvent).where(eq(consentEvent.meetingId, r.meetingId));
    expect(ce).toMatchObject({ eventType: "grant", channel: "discord", contactId: null });
    const artifact = ce!.captureArtifact as Record<string, unknown>;
    expect(artifact["members_present"]).toEqual(["u1", "u2"]);
    expect(String(artifact["notice"])).toContain("being recorded");
  });

  it("is idempotent on session_id and does not post the notice twice", async () => {
    const before = deps.adapters.discord.mock?.calls.length ?? 0;
    const r = await startMeeting(deps, { sessionId, guildId: "g1", channelId: "chan-a", startedAt, members });
    expect(r.created).toBe(false);
    expect(deps.adapters.discord.mock?.calls.length).toBe(before);
  });
});

describe("finaliseMeeting", () => {
  it("uploads every track, writes the rows and queues exactly one job", async () => {
    const r = await finaliseMeeting(deps, {
      sessionId, endedAt, participantCount: 2,
      tracks: [track("u1", 1_000), track("u2", 2_000)],
    });
    expect(r).toMatchObject({ closed: true, tracks: 2 });

    const store = deps.adapters.r2.store!;
    expect([...store.keys()].sort()).toEqual([
      `meetings/g1/chan-a/${startedAt.getTime()}/u1.opus`,
      `meetings/g1/chan-a/${startedAt.getTime()}/u2.opus`,
    ]);

    const tracks = await t.db.select().from(speakerTrack).where(eq(speakerTrack.meetingId, r.meetingId));
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ transcriptionState: "pending", durationSec: 120, byteSize: 1_000 });

    const recs = await t.db.select().from(recording).where(eq(recording.meetingId, r.meetingId));
    expect(recs).toHaveLength(2);
    // recording_retain_5y would have rejected anything shorter.
    expect(recs[0]!.retainUntil).toBe(retainUntil(endedAt));
    expect(recs[0]!.callId).toBeNull();

    const [m] = await t.db.select().from(meeting).where(eq(meeting.id, r.meetingId));
    expect(m!.endedAt).not.toBeNull();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ queue: "meeting", name: "postcall" });
    expect(enqueued[0]!.payload).toMatchObject({ session_id: sessionId, idempotency_key: `meeting:${sessionId}` });
  });

  it("does not re-upload or re-queue a meeting already closed", async () => {
    const uploadsBefore = deps.adapters.r2.store!.size;
    const r = await finaliseMeeting(deps, { sessionId, endedAt, participantCount: 2, tracks: [track("u3", 10)] });
    expect(r).toMatchObject({ closed: false, tracks: 0 });
    expect(deps.adapters.r2.store!.size).toBe(uploadsBefore);
    expect(enqueued).toHaveLength(1);
  });

  it("refuses to finalise a session that was never started", async () => {
    await expect(finaliseMeeting(deps, { sessionId: "never:started:1", endedAt, participantCount: 1, tracks: [] }))
      .rejects.toThrow(/unknown session/);
  });
});

describe("retention", () => {
  it("is exactly five years, which is the floor the DB check enforces", () => {
    // `now` is pinned so these assert the rule, not the date the suite runs on.
    expect(retainUntil(new Date("2026-09-17T00:00:00Z"), new Date("2026-09-17T00:00:00Z"))).toBe("2031-09-17");
    expect(retainUntil(new Date("2028-02-29T00:00:00Z"), new Date("2028-02-29T00:00:00Z"))).toBe("2033-03-01");
    // A meeting that ended before midnight but was finalised after it must still clear the CHECK.
    expect(retainUntil(new Date("2026-09-17T23:55:00Z"), new Date("2026-09-18T00:05:00Z"))).toBe("2031-09-18");
  });
});
