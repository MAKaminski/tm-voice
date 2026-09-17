import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AssistantDesiredState, SPEECH_PLAN, VOICE_PROFILE, createAdapters, vapiVoiceBlock } from "@tm/adapters";
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

/** The reviewed desired state, as a fixture. */
const desired: AssistantDesiredState = {
  firstMessage: "Hello.",
  voice: vapiVoiceBlock("voice_joe"),
  systemPrompt: "You are Joe.",
  backgroundSound: "off",
  speech: SPEECH_PLAN,
  recordingEnabled: true,
};

/**
 * A live assistant that matches a desired state on every owned field, plus the dashboard-owned
 * bits the sync must not touch. Built from `d` rather than hardcoded, so a test that changes the
 * desired state does not accidentally assert against a stale "in sync" shape.
 */
function liveFrom(d: AssistantDesiredState, id = "asst_1") {
  return {
    id,
    firstMessage: d.firstMessage,
    voice: { ...d.voice },
    backgroundSound: d.backgroundSound,
    artifactPlan: { recordingEnabled: d.recordingEnabled, transcriptPlan: { enabled: true } },
    model: {
      provider: "openai", model: "gpt-4o", toolIds: ["tool_book", "tool_optout"],
      messages: [{ role: "system", content: d.systemPrompt }],
    },
    silenceTimeoutSeconds: d.speech.silenceTimeoutSeconds,
    maxDurationSeconds: d.speech.maxDurationSeconds,
    startSpeakingPlan: { waitSeconds: d.speech.startWaitSeconds },
    stopSpeakingPlan: { numWords: d.speech.interruptWords, backoffSeconds: d.speech.interruptBackoffSeconds },
  };
}
const inSync = () => liveFrom(desired);

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
  it("reports nothing when the live assistant already matches", () => {
    expect(assistantDrift(desired, inSync())).toEqual([]);
  });

  it("names the settings that differ, not just that something did", () => {
    const live = { ...inSync(), voice: { ...desired.voice, stability: 0.9, style: 0 } };
    expect(assistantDrift(desired, live)).toEqual(["voice.stability", "voice.style"]);
  });

  it("catches a paraphrased opening line", () => {
    expect(assistantDrift(desired, { ...inSync(), firstMessage: "Hi there." })).toContain("firstMessage");
  });

  it("treats a bare assistant as full drift across every owned field", () => {
    // 1 opening line + 8 voice fields + prompt + backgroundSound + recording + 5 speech fields.
    expect(assistantDrift(desired, { id: "asst_1" })).toHaveLength(17);
  });

  it("catches recording being switched off, which makes the disclosure line untrue", () => {
    const live = { ...inSync(), artifactPlan: { recordingEnabled: false } };
    expect(assistantDrift(desired, live)).toEqual(["artifactPlan.recordingEnabled"]);
  });

  it("catches the two settings Joe's call actually tripped over", () => {
    // Ambient office noise left on, and a prompt edited in the dashboard.
    const live = { ...inSync(), backgroundSound: "office" };
    expect(assistantDrift(desired, live)).toEqual(["backgroundSound"]);
    const edited = { ...inSync(), model: { messages: [{ role: "system", content: "You are Joe. Always push the packet." }] } };
    expect(assistantDrift(desired, edited)).toEqual(["systemPrompt"]);
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
    const live = liveFrom(await desiredAssistant(c));
    c.adapters.vapi.getAssistant = async (id: string) => ({ ...live, id });
    await expect(vapiSyncAssistant(c, env)).resolves.toEqual({ assistant_id: "asst_1", in_sync: true });
    expect(c.adapters.vapi.mock!.calls.filter((x) => x.method === "updateAssistant")).toHaveLength(0);
  });
});
