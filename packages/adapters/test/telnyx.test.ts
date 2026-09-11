import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBHOOK_TOLERANCE_SEC, createTelnyxAdapter, mapCarrierType, telnyxWebhookOk } from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const LANDLINE = "+14045550100";

describe("mapCarrierType", () => {
  it("maps only an unambiguous fixed line to landline", () => {
    expect(mapCarrierType("fixed line")).toBe("landline");
    expect(mapCarrierType("mobile")).toBe("wireless");
    expect(mapCarrierType("voip")).toBe("voip");
  });
  it("never lets an ambiguous or unrecognised type become dialable under landline_only", () => {
    // "landline" is the only value surfaceAllows() accepts, so anything uncertain must not map to it.
    for (const t of ["fixed line or mobile", "toll free", "premium rate", "shared cost", "personal number", "pager", "uan", "voicemail", "unknown", undefined, ""]) {
      expect(mapCarrierType(t)).toBe("unknown");
    }
  });
});

describe("telnyx real adapter", () => {
  it("looks up carrier line type on the documented endpoint", async () => {
    const calls = stubFetch(() => ({ json: { data: { carrier: { type: "fixed line", name: "AT&T SE", normalized_carrier: "AT&T" } } } }));
    const t = createTelnyxAdapter(realConfig());
    expect(t.mode).toBe("real");
    await expect(t.lookupLineType(LANDLINE)).resolves.toEqual({ line_type: "landline", carrier: "AT&T" });
    expect(calls[0]!.url).toBe(`https://api.telnyx.com/v2/number_lookup/${encodeURIComponent(LANDLINE)}?type=carrier`);
    expect(calls[0]!.headers.authorization).toBe("Bearer x");
  });

  it("reports unknown when the response carries no carrier block", async () => {
    stubFetch(() => ({ json: { data: {} } }));
    await expect(createTelnyxAdapter(realConfig()).lookupLineType(LANDLINE)).resolves.toEqual({ line_type: "unknown", carrier: undefined });
  });

  it("rejects a malformed number before any network call", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await expect(createTelnyxAdapter(realConfig()).lookupLineType("404-555-0100")).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("dials with connection_id and a command_id derived from the call task", async () => {
    const taskId = "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a";
    const calls = stubFetch(() => ({ json: { data: { call_control_id: "cc_1" } } }));
    const t = createTelnyxAdapter(realConfig({ TELNYX_CONNECTION_ID: "conn_9" }));
    await expect(t.dial({ to: LANDLINE, from: "+14045550000", call_task_id: taskId })).resolves.toEqual({ call_control_id: "cc_1" });
    expect(calls[0]!.url).toBe("https://api.telnyx.com/v2/calls");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ connection_id: "conn_9", to: LANDLINE, from: "+14045550000", command_id: taskId });
  });

  it("fails loudly when the dial response has no call_control_id", async () => {
    stubFetch(() => ({ json: { data: {} } }));
    await expect(createTelnyxAdapter(realConfig()).dial({ to: LANDLINE, from: "+14045550000", call_task_id: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a" }))
      .rejects.toMatchObject({ code: "missing_call_control_id", retryable: false });
  });

  it("enforces DIAL_MODE before reaching the network", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    const t = createTelnyxAdapter(realConfig({ DIAL_MODE: "verified_only", DIAL_ALLOWLIST: LANDLINE }));
    await expect(t.dial({ to: "+14045550199", from: "+14045550000", call_task_id: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a" }))
      .rejects.toMatchObject({ code: "dial_mode_not_allowlisted" });
    expect(calls).toHaveLength(0);
  });
});

describe("telnyx webhook verification", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
  const body = JSON.stringify({ data: { event_type: "call.answered" } });
  const signFor = (ts: string, payload = body) => cryptoSign(null, Buffer.from(`${ts}|${payload}`, "utf8"), privateKey).toString("base64");

  it("accepts a genuine signature over `timestamp|body`", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(telnyxWebhookOk(pubB64, signFor(ts), ts, body)).toBe(true);
  });

  it("rejects a tampered body, a wrong key, and a missing header", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signFor(ts);
    expect(telnyxWebhookOk(pubB64, sig, ts, `${body} `)).toBe(false);
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    expect(telnyxWebhookOk(other, sig, ts, body)).toBe(false);
    expect(telnyxWebhookOk(pubB64, undefined, ts, body)).toBe(false);
    expect(telnyxWebhookOk(pubB64, sig, undefined, body)).toBe(false);
  });

  it("rejects a replay outside the tolerance window", () => {
    const now = Date.now();
    const stale = String(Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SEC - 1);
    expect(telnyxWebhookOk(pubB64, signFor(stale), stale, body, now)).toBe(false);
    const fresh = String(Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SEC + 5);
    expect(telnyxWebhookOk(pubB64, signFor(fresh), fresh, body, now)).toBe(true);
  });

  it("returns false rather than throwing on a malformed key or signature", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(telnyxWebhookOk("not-a-key", signFor(ts), ts, body)).toBe(false);
    expect(telnyxWebhookOk(pubB64, "AAAA", ts, body)).toBe(false);
    expect(telnyxWebhookOk(pubB64, signFor(ts), "not-a-number", body)).toBe(false);
  });

  it("is wired into the real adapter", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const t = createTelnyxAdapter(realConfig({ TELNYX_PUBLIC_KEY: pubB64 }));
    expect(t.verifyWebhook(signFor(ts), ts, body)).toBe(true);
    expect(t.verifyWebhook(signFor(ts), ts, "{}")).toBe(false);
  });
});
