import { MOCK_FIXTURES, createAdapters, setMockCompletion } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { meeting, recording, retainUntil, speakerTrack } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/context.js";
import {
  SYSTEM_PROMPT, buildNotes, externalKey, meetingExtract, notAlreadyOpen, parseTasks, renderTranscript,
  resolveRole, withVerifiableQuotes,
} from "../src/processors/extract.js";
import { meetingPostcall } from "../src/processors/meeting.js";
import { summaryLine } from "../src/processors/summary.js";

const cfg = loadConfig({
  DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123",
  TMOS_BOARD_URL: "https://tm-os.example/#today",
});
const env = (id: string) => ({ entity_id: id, idempotency_key: `x:${id}`, attempt: 0, enqueued_at: new Date().toISOString() });

let t: Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;

const turn = (speaker: string, at_sec: number, text: string) => ({ speaker, discord_user_id: speaker, at_sec, text });

/** The seeded fixture: a real-shaped meeting with two commitments and three things that are not. */
const FIXTURE = {
  michael: [
    "we should have the bot read back the address before it books",
    "it'd be cool if it could detect the accent someday",
  ],
  joe: [
    "add a field for gate code",
    "how many calls did we do last week",
  ],
};

beforeAll(async () => {
  t = await createTestDb();
  ctx = { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) };
});
afterAll(() => t.close());
afterEach(() => setMockCompletion(() => "[]"));

async function seedTranscribedMeeting(sessionId: string) {
  const [m] = await t.db.insert(meeting).values({
    discordGuildId: "g1", discordChannelId: "c1", sessionId,
    startedAt: new Date("2026-09-17T14:00:00Z"), endedAt: new Date("2026-09-17T14:45:00Z"),
    participantCount: 2, transcriptionState: "pending",
  }).returning();
  for (const [name, lines] of Object.entries(FIXTURE)) {
    const key = `meetings/g1/c1/${sessionId}/${name}.opus`;
    MOCK_FIXTURES[key] = lines;
    await ctx.adapters.r2.putObject(key, new Uint8Array([1]), "audio/ogg");
    const [track] = await t.db.insert(speakerTrack).values({
      meetingId: m!.id, discordUserId: name, displayName: name, r2Key: key,
      durationSec: 30, byteSize: 1, transcriptionState: "pending",
    }).returning();
    await t.db.insert(recording).values({ meetingId: m!.id, speakerTrackId: track!.id, r2Key: key, retainUntil: retainUntil(new Date()) });
  }
  await meetingPostcall(ctx, { ...env(m!.id), session_id: sessionId });
  return m!;
}

describe("the extraction rules the model is given", () => {
  it("names the brief's own examples on both sides of the line", () => {
    expect(SYSTEM_PROMPT).toContain("we should have the bot read back the address before it books");
    expect(SYSTEM_PROMPT).toContain("add a field for gate code");
    expect(SYSTEM_PROMPT).toContain("it'd be cool if");
    expect(SYSTEM_PROMPT).toContain("someday");
  });

  it("requires speaker, timestamp and a verbatim quote on every task", () => {
    for (const field of ["speaker", "at_sec", "quote"]) expect(SYSTEM_PROMPT).toContain(field);
    expect(SYSTEM_PROMPT).toContain("VERBATIM");
  });
});

describe("parsing what the model returns", () => {
  it("accepts a bare array and a fenced one", () => {
    const task = [{ title: "t", speaker: "s", at_sec: 1, quote: "q" }];
    expect(parseTasks(JSON.stringify(task))).toHaveLength(1);
    expect(parseTasks("```json\n" + JSON.stringify(task) + "\n```")).toHaveLength(1);
  });

  it("drops malformed entries instead of filing them", () => {
    expect(parseTasks('[{"title":"ok","speaker":"s","at_sec":1,"quote":"q"},{"title":""},{"nope":true}]')).toHaveLength(1);
  });

  it("returns nothing for prose, an object, or broken JSON", () => {
    expect(parseTasks("I could not find any tasks.")).toEqual([]);
    expect(parseTasks('{"title":"x"}')).toEqual([]);
    expect(parseTasks("[{")).toEqual([]);
  });
});

describe("quote verification", () => {
  const turns = [turn("Michael", 0, "we should have the bot read back the address before it books")];

  it("keeps a task whose quote is really in the transcript, punctuation aside", () => {
    const kept = withVerifiableQuotes(
      [{ title: "t", speaker: "Michael", at_sec: 0, quote: "Read back the address, before it books." }],
      turns,
    );
    expect(kept).toHaveLength(1);
  });

  it("drops a fabricated quote, which is what a hallucinated task looks like", () => {
    const kept = withVerifiableQuotes(
      [{ title: "t", speaker: "Michael", at_sec: 0, quote: "we agreed to rewrite the whole dialer in rust" }],
      turns,
    );
    expect(kept).toEqual([]);
  });

  it("drops a quote too short to be evidence of anything", () => {
    expect(withVerifiableQuotes([{ title: "t", speaker: "Michael", at_sec: 0, quote: "the" }], turns)).toEqual([]);
  });
});

describe("filtering and roles", () => {
  it("drops anything already open on the board", () => {
    const tasks = [
      { title: "Add a field for gate code", speaker: "Joe", at_sec: 1, quote: "q" },
      { title: "Something new", speaker: "Joe", at_sec: 2, quote: "q" },
    ];
    expect(notAlreadyOpen(tasks, ["add a field for gate code!"]).map((x) => x.title)).toEqual(["Something new"]);
  });

  it("honours a seeded role and refuses an invented one", () => {
    const roles = [{ id: "1", name: "Voice Bot Build", owner: "Michael", active: true }];
    expect(resolveRole("voice bot build", roles)).toBe("Voice Bot Build");
    expect(resolveRole("Machine Learning Platform", roles)).toBe("Task Intake");
    expect(resolveRole(undefined, roles)).toBe("Task Intake");
  });
});

describe("what lands on the card", () => {
  it("carries speaker, timestamp, verbatim quote and the audio", () => {
    const notes = buildNotes({ title: "t", speaker: "Joe", at_sec: 125, quote: "add a field for gate code" }, "s1", ["meetings/a.opus"]);
    expect(notes).toContain("Joe at 00:02:05");
    expect(notes).toContain('"add a field for gate code"');
    expect(notes).toContain("meetings/a.opus");
    expect(notes).toContain("Session s1");
  });

  it("numbers external keys from one so a replay collides on the same value", () => {
    expect(externalKey("g:c:1", 1)).toBe("vc:g:c:1:1");
  });

  it("renders the transcript with timestamps and speakers", () => {
    expect(renderTranscript([turn("Joe", 12.7, "hi")])).toBe("[12s] Joe: hi");
  });

  it("reports back in one line with a count, a duration and the board", () => {
    expect(summaryLine(3, 3_600, "https://b")).toBe("Recording stopped after 60 min — filed 3 tasks to the board: https://b");
    expect(summaryLine(1, 90, "https://b")).toContain("filed 1 task to");
    // A meeting shorter than a minute still reports a minute, not "0 min".
    expect(summaryLine(0, 12, "https://b")).toContain("after 1 min");
  });
});

describe("meeting.extract end to end", () => {
  it("files the commitments and nothing else, then reports back to the channel", async () => {
    const m = await seedTranscribedMeeting("s-e2e");

    // The model sees the transcript and returns both real commitments plus one musing and one
    // fabrication, which the pipeline must drop without them ever reaching the board.
    setMockCompletion((input) => {
      expect(input.prompt).toContain("add a field for gate code");
      expect(input.temperature).toBe(0);
      return JSON.stringify([
        { title: "Have the bot read the address back before booking", speaker: "michael", at_sec: 0, quote: "we should have the bot read back the address before it books", role: "Voice Bot Build" },
        { title: "Add a gate code field", speaker: "joe", at_sec: 0, quote: "add a field for gate code" },
        { title: "Detect the caller's accent", speaker: "michael", at_sec: 5, quote: "it'd be cool if it could detect the accent someday" },
        { title: "Rewrite the dialer", speaker: "joe", at_sec: 9, quote: "let us rewrite the entire dialer in rust next sprint" },
      ]);
    });

    const out = await meetingExtract(ctx, { ...env(m.id), session_id: "s-e2e" });
    // The musing survives quote verification (it was really said) but the fabrication does not.
    expect(out).toMatchObject({ meeting_id: m.id, candidates: 3, filed: 3 });

    const filed = [...ctx.adapters.tmos.tasks!.values()];
    expect(filed.map((x) => x.title)).not.toContain("Rewrite the dialer");
    expect(filed.every((x) => x.owner === "Claude" && x.status === "inbox" && x.source === "vc")).toBe(true);
    expect(filed.map((x) => x.external_key)).toEqual(["vc:s-e2e:1", "vc:s-e2e:2", "vc:s-e2e:3"]);

    const created = ctx.adapters.tmos.mock!.calls.filter((c) => c.method === "createTask");
    expect(created[0]!.args[0]).toMatchObject({ role: "Voice Bot Build" });
    expect(created[1]!.args[0]).toMatchObject({ role: "Task Intake" });
    expect(String((created[0]!.args[0] as { notes: string }).notes)).toContain("michael at 00:00:00");

    const posted = ctx.adapters.discord.mock!.calls.filter((c) => c.method === "postChannelMessage");
    expect(String((posted.at(-1)!.args[0] as { content: string }).content))
      .toBe("Recording stopped after 45 min — filed 3 tasks to the board: https://tm-os.example/#today");
  });

  it("running it twice files nothing twice", async () => {
    const before = ctx.adapters.tmos.tasks!.size;
    setMockCompletion(() => JSON.stringify([
      { title: "Have the bot read the address back before booking", speaker: "michael", at_sec: 0, quote: "we should have the bot read back the address before it books", role: "Voice Bot Build" },
      { title: "Add a gate code field", speaker: "joe", at_sec: 0, quote: "add a field for gate code" },
      { title: "Detect the caller's accent", speaker: "michael", at_sec: 5, quote: "it'd be cool if it could detect the accent someday" },
    ]));

    const out = await meetingExtract(ctx, { ...env("again"), session_id: "s-e2e" });
    // Caught by the already-open filter, before the board is written to at all: the tasks filed on
    // the first run are sitting in `inbox`, which listOpenTasks reports. The unique index on
    // external_key is the backstop under it (see the tmos adapter's own dedupe test), not the
    // first line of defence.
    expect(out).toMatchObject({ candidates: 0, filed: 0 });
    expect(ctx.adapters.tmos.tasks!.size).toBe(before);
    expect(ctx.adapters.tmos.mock!.calls.filter((c) => c.method === "createTask")).toHaveLength(before);
  });

  it("files nothing twice even if the board forgets they are open", async () => {
    // Belt and braces: with the already-open filter blinded, external_key still collides.
    const before = ctx.adapters.tmos.tasks!.size;
    const blinded = { ...ctx, adapters: { ...ctx.adapters, tmos: {
      ...ctx.adapters.tmos,
      listOpenTasks: async () => [],
    } } } as Ctx;
    setMockCompletion(() => JSON.stringify([
      { title: "Have the bot read the address back before booking", speaker: "michael", at_sec: 0, quote: "we should have the bot read back the address before it books" },
    ]));

    const out = await meetingExtract(blinded, { ...env("again2"), session_id: "s-e2e" });
    expect(out).toMatchObject({ candidates: 1, filed: 0 });
    expect(ctx.adapters.tmos.tasks!.size).toBe(before);
  });

  it("waits rather than extracting from a meeting still being transcribed", async () => {
    const [m] = await t.db.insert(meeting).values({
      discordGuildId: "g1", discordChannelId: "c1", sessionId: "s-pending",
      startedAt: new Date(), participantCount: 2, transcriptionState: "transcribing",
    }).returning();
    expect(await meetingExtract(ctx, { ...env(m!.id), session_id: "s-pending" }))
      .toMatchObject({ skipped: "not_transcribed", state: "transcribing" });
  });

  it("says so in the channel when a meeting produced nothing", async () => {
    const [m] = await t.db.insert(meeting).values({
      discordGuildId: "g1", discordChannelId: "c-quiet", sessionId: "s-quiet",
      startedAt: new Date("2026-09-17T14:00:00Z"), endedAt: new Date("2026-09-17T14:10:00Z"),
      participantCount: 2, transcriptionState: "transcribed",
    }).returning();
    const out = await meetingExtract(ctx, { ...env(m!.id), session_id: "s-quiet" });
    expect(out).toMatchObject({ filed: 0 });
    const posted = ctx.adapters.discord.mock!.calls.filter((c) => c.method === "postChannelMessage");
    expect(String((posted.at(-1)!.args[0] as { content: string }).content)).toContain("filed 0 tasks");
  });

  it("does not lose filed tasks because the channel post failed", async () => {
    const [m] = await t.db.insert(meeting).values({
      discordGuildId: "g1", discordChannelId: "c-gone", sessionId: "s-post-fails",
      startedAt: new Date(), endedAt: new Date(), participantCount: 1, transcriptionState: "transcribed",
    }).returning();
    const broken = { ...ctx, adapters: { ...ctx.adapters, discord: {
      ...ctx.adapters.discord,
      postChannelMessage: async () => { throw new Error("channel deleted"); },
    } } } as Ctx;
    await expect(meetingExtract(broken, { ...env(m!.id), session_id: "s-post-fails" })).resolves.toMatchObject({ filed: 0 });
  });
});
