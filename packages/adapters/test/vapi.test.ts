import { afterEach, describe, expect, it, vi } from "vitest";
import { createVapiAdapter } from "../src/index.js";
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
