import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VOICE_PROFILE, createAdapters, vapiVoiceBlock } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { DISCLOSURE_LINE, scriptVersion, seed } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import type { Ctx } from "../src/context.js";
import { assistantDrift, desiredAssistant, vapiSyncAssistant } from "../src/processors/voice.js";

const base = { DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123", VAPI_ASSISTANT_ID: "asst_1", ELEVENLABS_VOICE_ID: "voice_joe" };
let t: Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;

const env = { entity_id: "scheduler", idempotency_key: "vapi.syncAssistant", attempt: 0, enqueued_at: new Date().toISOString() };
const ctxWith = (over: Record<string, string> = {}): Ctx => {
  const cfg = loadConfig({ ...base, ...over });
  return { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) };
};

beforeAll(async () => {
  t = await createTestDb();
  await seed(t.db, { day: new Date(Date.now() + 86_400_000) });
  ctx = ctxWith();
});
afterAll(() => t.close());

beforeEach(async () => {
  await t.db.update(scriptVersion).set({ active: false });
  await t.db.update(scriptVersion).set({ active: true }).where(eq(scriptVersion.name, "v1-atlanta-pm"));
});

describe("desiredAssistant", () => {
  it("takes the opening line from the active script version, verbatim", async () => {
    const d = await desiredAssistant(ctx);
    // Rule 10: the disclosure line is not paraphrased, reformatted or wrapped.
    expect(d.firstMessage).toBe(DISCLOSURE_LINE);
  });

  it("carries the checked-in profile and the env voice id", async () => {
    const d = await desiredAssistant(ctx);
    expect(d.voice).toEqual(vapiVoiceBlock("voice_joe", VOICE_PROFILE));
  });

  it("refuses to guess when no script version is active", async () => {
    await t.db.update(scriptVersion).set({ active: false });
    await expect(desiredAssistant(ctx)).rejects.toThrow(/expected exactly 1 active script_version, found 0/);
  });

  it("refuses to guess when two are active", async () => {
    await t.db.insert(scriptVersion).values({ name: "v2-draft", disclosureLine: "Different line.", active: true });
    await expect(desiredAssistant(ctx)).rejects.toThrow(/found 2/);
    await t.db.delete(scriptVersion).where(eq(scriptVersion.name, "v2-draft"));
  });

  it("refuses to sync without a voice id, rather than PATCHing a voiceless assistant", async () => {
    await expect(desiredAssistant(ctxWith({ ELEVENLABS_VOICE_ID: "" }))).rejects.toThrow(/ELEVENLABS_VOICE_ID/);
  });
});

describe("assistantDrift", () => {
  const desired = { firstMessage: "Hello.", voice: vapiVoiceBlock("voice_joe") };

  it("reports nothing when the live assistant already matches", () => {
    expect(assistantDrift(desired, { firstMessage: "Hello.", voice: { ...desired.voice } })).toEqual([]);
  });

  it("names the settings that differ, not just that something did", () => {
    const live = { firstMessage: "Hello.", voice: { ...desired.voice, stability: 0.9, style: 0 } };
    expect(assistantDrift(desired, live)).toEqual(["voice.stability", "voice.style"]);
  });

  it("catches a paraphrased opening line", () => {
    expect(assistantDrift(desired, { firstMessage: "Hi there.", voice: { ...desired.voice } })).toContain("firstMessage");
  });

  it("treats a missing voice block as full drift", () => {
    expect(assistantDrift(desired, {})).toHaveLength(9);
  });
});

describe("vapiSyncAssistant", () => {
  it("PATCHes when the live assistant has drifted", async () => {
    const c = ctxWith();
    const res = await vapiSyncAssistant(c, env) as { in_sync: boolean; drift: string[] };
    expect(res.in_sync).toBe(false);
    // The mock's getAssistant returns a bare row, so everything reads as drift and the PATCH is recorded.
    expect(res.drift).toContain("voice.stability");
    expect(c.adapters.vapi.mock!.calls.at(-1)).toMatchObject({ method: "updateAssistant" });
  });

  it("skips cleanly when no assistant is configured", async () => {
    const c = ctxWith({ VAPI_ASSISTANT_ID: "" });
    await expect(vapiSyncAssistant(c, env)).resolves.toEqual({ skipped: "no_assistant_id" });
    expect(c.adapters.vapi.mock!.calls).toHaveLength(0);
  });

  it("does not PATCH when the live assistant already matches", async () => {
    const c = ctxWith();
    const desired = await desiredAssistant(c);
    c.adapters.vapi.getAssistant = async (id: string) => ({ id, firstMessage: desired.firstMessage, voice: { ...desired.voice } });
    await expect(vapiSyncAssistant(c, env)).resolves.toEqual({ assistant_id: "asst_1", in_sync: true });
    expect(c.adapters.vapi.mock!.calls.filter((x) => x.method === "updateAssistant")).toHaveLength(0);
  });
});
