import { MOCK_FIXTURES, REQUEST_BYTE_LIMIT, createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { meeting, recording, speakerTrack, transcript } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/context.js";
import { type MeetingTurn, chunkOgg, meetingPostcall, mergeTurns } from "../src/processors/meeting.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const env = (id: string) => ({ entity_id: id, idempotency_key: `meeting:${id}`, attempt: 0, enqueued_at: new Date().toISOString() });

let t: Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;

/** Builds a meeting with two speakers whose audio is already in the mock R2 store. */
async function seedMeeting(sessionId: string, speakers: { id: string; name: string; lines: string[] }[]) {
  const [m] = await t.db.insert(meeting).values({
    discordGuildId: "g1", discordChannelId: "c1", sessionId,
    startedAt: new Date("2026-09-17T14:00:00Z"), endedAt: new Date("2026-09-17T15:00:00Z"),
    participantCount: speakers.length, transcriptionState: "pending",
  }).returning();
  for (const s of speakers) {
    const key = `meetings/g1/c1/${sessionId}/${s.id}.opus`;
    MOCK_FIXTURES[key] = s.lines;
    await ctx.adapters.r2.putObject(key, new Uint8Array([1, 2, 3]), "audio/ogg");
    const [track] = await t.db.insert(speakerTrack).values({
      meetingId: m!.id, discordUserId: s.id, displayName: s.name, r2Key: key,
      durationSec: 60, byteSize: 3, transcriptionState: "pending",
    }).returning();
    await t.db.insert(recording).values({ meetingId: m!.id, speakerTrackId: track!.id, r2Key: key, retainUntil: "2031-09-17" });
  }
  return m!;
}

beforeAll(async () => {
  t = await createTestDb();
  ctx = { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) };
});
afterAll(() => t.close());
beforeEach(() => { for (const k of Object.keys(MOCK_FIXTURES)) delete MOCK_FIXTURES[k]; });

describe("chunking for the request limit", () => {
  it("leaves a normal track whole", () => {
    expect(chunkOgg(new Uint8Array(1_000))).toHaveLength(1);
  });

  it("splits only on Ogg page boundaries, so every piece still decodes", () => {
    // Four pages of 40 bytes, limit 100: the split must land on an "OggS", never mid-page.
    const page = (n: number) => [0x4f, 0x67, 0x67, 0x53, ...new Array(36).fill(n)];
    const audio = new Uint8Array([...page(1), ...page(2), ...page(3), ...page(4)]);
    const chunks = chunkOgg(audio, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect([...c.subarray(0, 4)]).toEqual([0x4f, 0x67, 0x67, 0x53]);
    expect(Buffer.concat(chunks.map(Buffer.from))).toEqual(Buffer.from(audio));
  });

  it("hands non-Ogg bytes straight to the adapter rather than guessing where to cut", () => {
    expect(chunkOgg(new Uint8Array(REQUEST_BYTE_LIMIT + 10).fill(7), 100)).toHaveLength(1);
  });
});

describe("merging tracks", () => {
  const track = (id: string, name: string | null, segs: [number, string][]) => ({
    discordUserId: id, displayName: name,
    segments: segs.map(([start_sec, text]) => ({ start_sec, end_sec: start_sec + 1, text })),
  });

  it("orders by timestamp across speakers", () => {
    const merged = mergeTurns([track("u1", "Michael", [[0, "a"], [10, "c"]]), track("u2", "Joe", [[5, "b"]])]);
    expect(merged.map((x) => x.text)).toEqual(["a", "b", "c"]);
    expect(merged[1]).toMatchObject({ speaker: "Joe", discord_user_id: "u2", at_sec: 5 });
  });

  it("breaks ties deterministically, so a replay produces the same input for extraction", () => {
    const a = mergeTurns([track("u2", "Joe", [[5, "joe"]]), track("u1", "Michael", [[5, "michael"]])]);
    const b = mergeTurns([track("u1", "Michael", [[5, "michael"]]), track("u2", "Joe", [[5, "joe"]])]);
    expect(a).toEqual(b);
    expect(a.map((x) => x.text)).toEqual(["michael", "joe"]);
  });

  it("falls back to the discord id when a display name was never captured", () => {
    expect(mergeTurns([track("u9", null, [[0, "x"]])])[0]!.speaker).toBe("u9");
  });
});

describe("meeting.postcall", () => {
  it("transcribes every track and writes one merged transcript", async () => {
    const m = await seedMeeting("s1", [
      { id: "u1", name: "Michael", lines: ["add a field for gate code", "and read the address back"] },
      { id: "u2", name: "Joe", lines: ["sounds right"] },
    ]);

    const out = await meetingPostcall(ctx, { ...env(m.id), session_id: "s1" });
    expect(out).toMatchObject({ meeting_id: m.id, tracks: 2, transcribed_now: 2, turns: 3 });

    const [row] = await t.db.select().from(transcript).where(eq(transcript.meetingId, m.id));
    expect(row!.callId).toBeNull();
    const turns = row!.turns as MeetingTurn[];
    expect(turns.map((x) => x.speaker)).toEqual(["Michael", "Joe", "Michael"]);
    expect(turns[0]!.text).toBe("add a field for gate code");

    const [after] = await t.db.select().from(meeting).where(eq(meeting.id, m.id));
    expect(after!.transcriptionState).toBe("transcribed");
    const tracks = await t.db.select().from(speakerTrack).where(eq(speakerTrack.meetingId, m.id));
    expect(tracks.every((x) => x.transcriptionState === "transcribed")).toBe(true);
  });

  it("replaying the same job yields identical state and no duplicate rows", async () => {
    const m = await seedMeeting("s2", [{ id: "u1", name: "Michael", lines: ["one", "two"] }]);
    const first = await meetingPostcall(ctx, { ...env(m.id), session_id: "s2" });
    const snapshot = await t.db.select().from(transcript).where(eq(transcript.meetingId, m.id));

    const second = await meetingPostcall(ctx, { ...env(m.id), session_id: "s2" });
    expect(second).toMatchObject({ skipped: "already_processed", meeting_id: m.id });
    expect(first).not.toMatchObject({ skipped: "already_processed" });

    const again = await t.db.select().from(transcript).where(eq(transcript.meetingId, m.id));
    expect(again).toHaveLength(1);
    expect(again[0]!.turns).toEqual(snapshot[0]!.turns);
    expect(await t.db.select().from(speakerTrack).where(eq(speakerTrack.meetingId, m.id))).toHaveLength(1);
  });

  it("resumes on the tracks left rather than re-transcribing the ones already done", async () => {
    const m = await seedMeeting("s3", [
      { id: "u1", name: "Michael", lines: ["done already"] },
      { id: "u2", name: "Joe", lines: ["still pending"] },
    ]);
    // Simulate a crash after the first track: mark it transcribed with its segments already stored.
    await t.db.update(speakerTrack)
      .set({ transcriptionState: "transcribed", segments: [{ start_sec: 0, end_sec: 4, text: "done already" }] })
      .where(eq(speakerTrack.discordUserId, "u1"));

    const before = ctx.adapters.stt_batch.mock!.calls.length;
    const out = await meetingPostcall(ctx, { ...env(m.id), session_id: "s3" });

    expect(out).toMatchObject({ tracks: 2, transcribed_now: 1 });
    expect(ctx.adapters.stt_batch.mock!.calls.length - before).toBe(1);
    const [row] = await t.db.select().from(transcript).where(eq(transcript.meetingId, m.id));
    expect((row!.turns as MeetingTurn[]).map((x) => x.text)).toEqual(["done already", "still pending"]);
  });

  it("marks the meeting and the track failed and rethrows, so BullMQ retries", async () => {
    const m = await seedMeeting("s4", [{ id: "u1", name: "Michael", lines: ["x"] }]);
    // The object is gone from R2; the read must not be swallowed.
    await ctx.adapters.r2.deleteObject(`meetings/g1/c1/s4/u1.opus`);

    await expect(meetingPostcall(ctx, { ...env(m.id), session_id: "s4" })).rejects.toMatchObject({ vendor: "r2", code: "http_404" });
    const [after] = await t.db.select().from(meeting).where(eq(meeting.id, m.id));
    expect(after!.transcriptionState).toBe("failed");
    const [track] = await t.db.select().from(speakerTrack).where(eq(speakerTrack.meetingId, m.id));
    expect(track!.transcriptionState).toBe("failed");
  });

  it("closes a meeting where nobody spoke instead of failing it", async () => {
    const m = await seedMeeting("s5", []);
    const out = await meetingPostcall(ctx, { ...env(m.id), session_id: "s5" });
    expect(out).toMatchObject({ tracks: 0, turns: 0 });
    const [after] = await t.db.select().from(meeting).where(eq(meeting.id, m.id));
    expect(after!.transcriptionState).toBe("transcribed");
  });

  it("ignores a session we never captured rather than throwing", async () => {
    expect(await meetingPostcall(ctx, { ...env("x"), session_id: "never" })).toMatchObject({ skipped: "unknown_meeting" });
  });
});
