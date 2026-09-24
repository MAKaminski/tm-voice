import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_PROFILE, createVapiAdapter, vapiVoiceBlock , SPEECH_PLAN} from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const TASK = "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a";
const CONTACT = "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6b";
const call = { to: "+14045550100", from: "+14045550000", assistant_id: "asst_1", metadata: { call_task_id: TASK, contact_id: CONTACT } };

/** Vapi addresses the caller ID by phoneNumberId, so every dial first resolves the DID. */
const numbersThenCall = (id = "call_1") => stubFetch((c) =>
  c.url.includes("/phone-number")
    ? { json: [{ id: "pn_other", number: "+19995550000" }, { id: "pn_1", number: "+14045550000" }] }
    : { json: { id } });

describe("vapi real adapter", () => {
  it("resolves the from number to a phoneNumberId and posts the documented body", async () => {
    const calls = numbersThenCall();
    const v = createVapiAdapter(realConfig());
    expect(v.mode).toBe("real");
    await expect(v.createOutboundCall(call)).resolves.toEqual({ id: "call_1", synthetic: false });
    expect(calls[0]!.url).toBe("https://api.vapi.ai/phone-number?limit=1000");
    expect(calls[1]!.url).toBe("https://api.vapi.ai/call");
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      assistantId: "asst_1", phoneNumberId: "pn_1", customer: { number: "+14045550100" }, name: TASK,
    });
  });

  it("carries the call_task_id in `name`, which Vapi caps at 40 chars", async () => {
    const calls = numbersThenCall();
    await createVapiAdapter(realConfig()).createOutboundCall(call);
    const name = JSON.parse(calls[1]!.body!).name as string;
    expect(name).toBe(TASK);
    expect(name.length).toBeLessThanOrEqual(40);
  });

  it("caches the phone number lookup across dials", async () => {
    const calls = numbersThenCall();
    const v = createVapiAdapter(realConfig());
    await v.createOutboundCall(call);
    await v.createOutboundCall(call);
    expect(calls.filter((c) => c.url.includes("/phone-number"))).toHaveLength(1);
  });

  it("refuses a from number that is not imported into Vapi", async () => {
    stubFetch(() => ({ json: [{ id: "pn_1", number: "+19995550000" }] }));
    await expect(createVapiAdapter(realConfig()).createOutboundCall(call))
      .rejects.toMatchObject({ code: "unknown_from_number", retryable: false });
  });

  it("fails loudly when the create response has no id", async () => {
    stubFetch((c) => (c.url.includes("/phone-number") ? { json: [{ id: "pn_1", number: "+14045550000" }] } : { json: {} }));
    await expect(createVapiAdapter(realConfig()).createOutboundCall(call))
      .rejects.toMatchObject({ code: "missing_call_id", retryable: false });
  });

  it("enforces DIAL_MODE before any network call", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    const v = createVapiAdapter(realConfig({ DIAL_MODE: "verified_only", DIAL_ALLOWLIST: "+14045550111" }));
    await expect(v.createOutboundCall(call)).rejects.toMatchObject({ code: "dial_mode_not_allowlisted" });
    expect(calls).toHaveLength(0);
  });

  it("reads status and artifacts off getCall", async () => {
    const calls = stubFetch(() => ({ json: { id: "call_1", status: "ended", artifact: { recordingUrl: "https://r.vapi/1.wav", transcript: "hello" } } }));
    await expect(createVapiAdapter(realConfig()).getCall("call_1")).resolves.toEqual({
      id: "call_1", status: "ended", recording_url: "https://r.vapi/1.wav", transcript: "hello",
    });
    expect(calls[0]!.url).toBe("https://api.vapi.ai/call/call_1");
  });

  it("falls back to the stereo recording and tolerates a missing artifact", async () => {
    stubFetch(() => ({ json: { id: "c", status: "ended", artifact: { stereoRecordingUrl: "https://r.vapi/s.wav" } } }));
    await expect(createVapiAdapter(realConfig()).getCall("c")).resolves.toMatchObject({ recording_url: "https://r.vapi/s.wav" });
    stubFetch(() => ({ json: { id: "c" } }));
    await expect(createVapiAdapter(realConfig()).getCall("c")).resolves.toEqual({ id: "c", status: "unknown", recording_url: undefined, transcript: undefined });
  });
});

const DISCLOSURE = "Hi, this is an automated assistant using an artificial voice.";
const desired = {
  firstMessage: DISCLOSURE,
  voice: vapiVoiceBlock("voice_joe"),
  systemPrompt: "You are Joe.",
  backgroundSound: "off" as const,
  speech: SPEECH_PLAN,
  recordingEnabled: true as const,
};

describe("vapi assistant sync", () => {
  /** What a live assistant looks like, including the dashboard-owned bits a sync must preserve. */
  const liveBody = {
    id: "asst_1",
    model: { provider: "openai", model: "gpt-4o", toolIds: ["tool_book"], messages: [{ role: "system", content: "old" }] },
    artifactPlan: { recordingEnabled: false, transcriptPlan: { enabled: true } },
  };

  it("PATCHes the owned surface", async () => {
    const calls = stubFetch(() => ({ json: liveBody }));
    await expect(createVapiAdapter(realConfig()).updateAssistant("asst_1", desired))
      .resolves.toEqual({ id: "asst_1", synthetic: false });
    // Reads the assistant first: the model object has to be merged, never rebuilt.
    expect(calls.map((x) => x.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.url).toBe("https://api.vapi.ai/assistant/asst_1");
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toMatchObject({
      firstMessage: DISCLOSURE,
      voice: { provider: "11labs", voiceId: "voice_joe", ...VOICE_PROFILE },
      backgroundSound: "off",
      silenceTimeoutSeconds: 20,
      startSpeakingPlan: { waitSeconds: 0.8 },
      stopSpeakingPlan: { numWords: 2, backoffSeconds: 1.5 },
    });
    expect(body.model.messages[0]).toEqual({ role: "system", content: "You are Joe." });
  });

  it("skips the read when the caller already has the live assistant", async () => {
    const calls = stubFetch(() => ({ json: liveBody }));
    await createVapiAdapter(realConfig()).updateAssistant("asst_1", desired, liveBody);
    expect(calls.map((x) => x.method)).toEqual(["PATCH"]);
  });

  it("keeps the dashboard's model choice and tool wiring through a sync", async () => {
    const calls = stubFetch(() => ({ json: liveBody }));
    await createVapiAdapter(realConfig()).updateAssistant("asst_1", desired, liveBody);
    const body = JSON.parse(calls[0]!.body!);
    // Which LLM it runs and which tools it can call stay dashboard decisions.
    expect(body.model).toMatchObject({ provider: "openai", model: "gpt-4o", toolIds: ["tool_book"] });
    // And the transcriber is never sent at all.
    expect(Object.keys(body).sort()).toEqual([
      "artifactPlan", "backgroundSound", "firstMessage", "maxDurationSeconds", "model",
      "silenceTimeoutSeconds", "startSpeakingPlan", "stopSpeakingPlan", "voice",
    ]);
  });

  it("refuses an out-of-range profile before it reaches the network", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    const bad = { ...desired, voice: { ...desired.voice, speed: 2 } };
    await expect(createVapiAdapter(realConfig()).updateAssistant("asst_1", bad))
      .rejects.toMatchObject({ code: "invalid_input", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("reads back the owned fields", async () => {
    const calls = stubFetch(() => ({ json: { id: "asst_1", firstMessage: DISCLOSURE, voice: { provider: "11labs", stability: 0.9 } } }));
    await expect(createVapiAdapter(realConfig()).getAssistant("asst_1")).resolves.toEqual({
      id: "asst_1", firstMessage: DISCLOSURE, voice: { provider: "11labs", stability: 0.9 },
    });
    expect(calls[0]!.url).toBe("https://api.vapi.ai/assistant/asst_1");
  });

  it("records the PATCH instead of sending it in dry_run", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    const v = createVapiAdapter(realConfig({ DIAL_MODE: "dry_run" }));
    expect(v.mode).toBe("mock");
    await expect(v.updateAssistant("asst_1", desired)).resolves.toEqual({ id: "asst_1", synthetic: true });
    expect(calls).toHaveLength(0);
    const rec = v.mock!.calls.at(-1)!;
    expect(rec.method).toBe("updateAssistant");
    expect(rec.args[0]).toBe("asst_1");
    expect(rec.args[1]).toEqual(desired);
    // The merged model is recorded too, so a dry run shows what the PATCH would have carried.
    expect(rec.args[2]).toMatchObject({ model: { messages: [{ role: "system", content: "You are Joe." }] } });
  });
});

/**
 * Vapi's recording storage is private: the `recordingUrl` in an end-of-call report answers 400 to a
 * direct GET, which is why no recording was ever stored. These pin the documented route
 * (docs.vapi.ai/assistants/retrieve-call-artifacts) and, above all, where the key is sent.
 */
describe("vapi downloadRecording", () => {
  const SIGNED = "https://signed.example.com/rec.wav?X-Amz-Signature=secret-sig";
  const twoHops = (second: { status?: number; text?: string; headers?: Record<string, string> } = {}) => stubFetch((c) =>
    c.url.startsWith("https://api.vapi.ai/")
      ? { status: 302, headers: { location: SIGNED } }
      : { status: 200, text: "RIFF-audio-bytes", headers: { "content-type": "audio/wav" }, ...second });

  it("asks Vapi for the call's mono recording by id, with the key, and follows the redirect by hand", async () => {
    const calls = twoHops();
    const out = await createVapiAdapter(realConfig()).downloadRecording("call_abc");
    expect(calls[0]!.url).toBe("https://api.vapi.ai/call/call_abc/mono-recording");
    expect(calls[0]!.headers["authorization"]).toMatch(/^Bearer /);
    expect(calls[0]!.redirect).toBe("manual");
    expect(calls[1]!.url).toBe(SIGNED);
    expect(new TextDecoder().decode(out.bytes)).toBe("RIFF-audio-bytes");
    expect(out.contentType).toBe("audio/wav");
  });

  it("never sends the key to the signed URL", async () => {
    // The signature is the second hop's credential. A pre-signed store that also receives an
    // Authorization header rejects the request as carrying two auth mechanisms.
    const calls = twoHops();
    await createVapiAdapter(realConfig()).downloadRecording("call_abc");
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
  });

  it("says which hop failed and what came back, without leaking the signed URL", async () => {
    twoHops({ status: 403, text: "<Error><Code>AccessDenied</Code></Error>" });
    const err = await createVapiAdapter(realConfig()).downloadRecording("call_abc").catch((e: Error) => e);
    expect(String(err)).toContain("http_403 on signed-download for call call_abc");
    expect(String(err)).toContain("AccessDenied");
    expect(String(err)).not.toContain("secret-sig");
  });

  it("reports a refusal from Vapi itself as the first hop", async () => {
    stubFetch(() => ({ status: 404, text: '{"message":"Recording not found"}' }));
    const err = await createVapiAdapter(realConfig()).downloadRecording("call_abc").catch((e: Error) => e);
    expect(String(err)).toContain("http_404 on mono-recording for call call_abc");
    expect(String(err)).toContain("Recording not found");
  });

  it("treats a redirect with nowhere to go as a failure, not an empty recording", async () => {
    stubFetch(() => ({ status: 302 }));
    await expect(createVapiAdapter(realConfig()).downloadRecording("call_abc")).rejects.toThrow("redirect_without_location");
  });
});
