import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { call, callTask, recording, retainUntil, seed } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/context.js";
import { postcallRecording, recordingKey } from "../src/processors/recording.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const env = (id: string) => ({ entity_id: id, idempotency_key: `postcall:recording:${id}`, attempt: 0, enqueued_at: new Date().toISOString() });

let t: Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let callId: string;
const VAPI_ID = "vapi_rec_1";
const URL_ = "https://storage.vapi.ai/rec-1.wav";
/** Fixed so the R2 key assertions stay stable; deliberately in the past, which is the case that broke. */
const STARTED_AT = new Date("2026-09-17T14:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  const r = await seed(t.db);
  ctx = { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) };
  const [task] = await t.db.select().from(callTask).limit(1);
  const [c] = await t.db.insert(call).values({
    callTaskId: task!.id, didId: r.did.id, vapiCallId: VAPI_ID, startedAt: STARTED_AT,
  }).returning();
  callId = c!.id;
});
afterAll(() => t.close());
beforeEach(async () => { await t.db.delete(recording); });

describe("retention", () => {
  // `now` is injected throughout so these assert the rule rather than the date the suite runs on.
  it("is exactly five years, which is the floor the DB check enforces", () => {
    const at = (iso: string) => new Date(iso);
    expect(retainUntil(at("2026-09-17T00:00:00Z"), at("2026-09-17T00:00:00Z"))).toBe("2031-09-17");
    expect(retainUntil(at("2028-02-29T00:00:00Z"), at("2028-02-29T00:00:00Z"))).toBe("2033-03-01");
  });

  /**
   * The CHECK is anchored to created_at, so a recording stored on a later UTC day than its call
   * began used to compute a retain_until below the floor and the insert was rejected outright.
   */
  it("measures from now, not the call, when storage lands on a later day", () => {
    const started = new Date("2026-09-17T23:55:00Z");
    const stored = new Date("2026-09-18T00:05:00Z");
    expect(retainUntil(started, stored)).toBe("2031-09-18");
    expect(retainUntil(started, stored) >= "2031-09-18").toBe(true); // created_at::date + 5y
  });

  it("never shortens the window when the call is the later of the two", () => {
    const started = new Date("2026-09-18T12:00:00Z");
    expect(retainUntil(started, new Date("2026-09-18T00:00:00Z"))).toBe("2031-09-18");
  });
});

describe("the R2 key", () => {
  it("is one prefix per month, so a retention sweep is one listing", () => {
    expect(recordingKey("abc", new Date("2026-09-17T14:00:00Z"), "audio/wav")).toBe("calls/2026/09/abc.wav");
    expect(recordingKey("abc", new Date("2026-01-05T14:00:00Z"), "audio/wav")).toBe("calls/2026/01/abc.wav");
  });

  it("follows the content type rather than assuming wav", () => {
    expect(recordingKey("abc", new Date("2026-09-17T00:00:00Z"), "audio/mpeg")).toMatch(/\.mp3$/);
    expect(recordingKey("abc", new Date("2026-09-17T00:00:00Z"), "audio/ogg")).toMatch(/\.ogg$/);
  });
});

describe("postcall.recording", () => {
  it("downloads the audio, stores it, and writes the row", async () => {
    const out = await postcallRecording(ctx, { ...env(callId), vapi_call_id: VAPI_ID, recording_url: URL_ }) as { r2_key: string; bytes: number };
    expect(out.r2_key).toBe(`calls/2026/09/${callId}.wav`);
    expect(out.bytes).toBeGreaterThan(0);

    // The object exists in R2 before the row does, so a crash between them leaves an inert object
    // rather than a row pointing at nothing.
    expect(ctx.adapters.r2.store!.has(out.r2_key)).toBe(true);

    const [row] = await t.db.select().from(recording).where(eq(recording.callId, callId));
    expect(row).toMatchObject({ r2Key: out.r2_key, retainUntil: retainUntil(STARTED_AT), callId });
    expect(row!.signedUrl).toBeNull();
  });

  it("does not re-download or duplicate on a replay", async () => {
    await postcallRecording(ctx, { ...env(callId), vapi_call_id: VAPI_ID, recording_url: URL_ });
    const downloadsBefore = ctx.adapters.vapi.mock!.calls.filter((c) => c.method === "downloadRecording").length;

    const second = await postcallRecording(ctx, { ...env(callId), vapi_call_id: VAPI_ID, recording_url: URL_ });
    expect(second).toMatchObject({ skipped: "already_stored" });
    expect(ctx.adapters.vapi.mock!.calls.filter((c) => c.method === "downloadRecording").length).toBe(downloadsBefore);
    expect(await t.db.select().from(recording).where(eq(recording.callId, callId))).toHaveLength(1);
  });

  it("writes no row when the download fails, so the sweeper never reports audio we cannot produce", async () => {
    const broken = { ...ctx, adapters: { ...ctx.adapters, vapi: {
      ...ctx.adapters.vapi, downloadRecording: async () => { throw new Error("url expired"); },
    } } } as Ctx;
    await expect(postcallRecording(broken, { ...env(callId), vapi_call_id: VAPI_ID, recording_url: URL_ })).rejects.toThrow("url expired");
    expect(await t.db.select().from(recording).where(eq(recording.callId, callId))).toHaveLength(0);
  });

  it("ignores a recording for a call we did not place", async () => {
    expect(await postcallRecording(ctx, { ...env("x"), vapi_call_id: "never", recording_url: URL_ }))
      .toMatchObject({ skipped: "unknown_call" });
  });
});
