import { AdapterError, loadConfig } from "@tm/shared";
import { describe, expect, it } from "vitest";
import { assertDialAllowed, createAdapters, createVapiAdapter, healthcheckAll, withRetry } from "../src/index.js";

const base = { DATABASE_URL: "postgres://x", INTERNAL_API_TOKEN: "0123456789abcdef0123" };
const allKeys = Object.fromEntries([
  "APOLLO_API_KEY","HCP_API_KEY","TELNYX_API_KEY","TELNYX_CONNECTION_ID","TELNYX_PUBLIC_KEY","VAPI_PRIVATE_KEY","VAPI_WEBHOOK_SECRET",
  "VAPI_ASSISTANT_ID","DEEPGRAM_API_KEY","ELEVENLABS_API_KEY","ELEVENLABS_VOICE_ID","LLM_PROVIDER","LLM_API_KEY","LLM_MODEL","RESEND_API_KEY",
  "MAIL_FROM","MS_TENANT_ID","MS_CLIENT_ID","MS_CLIENT_CERT_PEM","MS_BOOKING_MAILBOX","R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET","DNC_API_KEY",
].map((k) => [k, "x"]));

describe("adapters in dry_run", () => {
  const cfg = loadConfig(base);
  const a = createAdapters(cfg);
  it("all eight are mocks and healthy", async () => {
    const h = await healthcheckAll(a);
    expect(h).toHaveLength(8);
    expect(h.every((x) => x.ok && x.mode === "mock")).toBe(true);
  });
  it("vapi returns a synthetic call and never networks", async () => {
    const r = await a.vapi.createOutboundCall({ to: "+14045550100", from: "+14045550000", assistant_id: "asst", metadata: { call_task_id: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a", contact_id: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6b" } });
    expect(r.synthetic).toBe(true);
    expect(a.vapi.mock?.calls[0]?.method).toBe("createOutboundCall");
  });
  it("write mocks are idempotent on their key", async () => {
    const input = { to: "a@b.co", subject: "s", html: "<p/>", template: "packet", idempotency_key: "k1" };
    expect((await a.resend.sendEmail(input)).id).toBe((await a.resend.sendEmail(input)).id);
  });
  it("rejects invalid input with a structured AdapterError", async () => {
    await expect(a.dnc.lookup("x")).resolves.toBeDefined();
    await expect(a.telnyx.dial({ to: "bad", from: "+14045550000", call_task_id: "nope" })).rejects.toMatchObject({ code: "invalid_input", vendor: "telnyx", retryable: false });
  });
});

describe("DIAL_MODE enforcement", () => {
  it("verified_only rejects numbers outside the allowlist", () => {
    const cfg = { DIAL_MODE: "verified_only" as const, DIAL_ALLOWLIST: ["+14045550100"] };
    expect(() => assertDialAllowed(cfg, "vapi", "+14045550100")).not.toThrow();
    expect(() => assertDialAllowed(cfg, "vapi", "+14045550101")).toThrow(/not in DIAL_ALLOWLIST/);
  });
  it("live passes through; dry_run never reaches the real path", () => {
    expect(() => assertDialAllowed({ DIAL_MODE: "live", DIAL_ALLOWLIST: [] }, "telnyx", "+14045550101")).not.toThrow();
    expect(() => assertDialAllowed({ DIAL_MODE: "dry_run", DIAL_ALLOWLIST: [] }, "telnyx", "+14045550101")).toThrow(/dry_run/);
  });
  it("real vapi adapter enforces the allowlist before any network call", async () => {
    const cfg = loadConfig({ ...base, ...allKeys, REDIS_URL: "redis://x", DIAL_MODE: "verified_only", DIAL_ALLOWLIST: "+14045550100" });
    const v = createVapiAdapter(cfg);
    expect(v.mode).toBe("real");
    await expect(v.createOutboundCall({ to: "+14045550199", from: "+14045550000", assistant_id: "a", metadata: { call_task_id: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a", contact_id: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6b" } }))
      .rejects.toMatchObject({ code: "dial_mode_not_allowlisted" });
  });
});

describe("withRetry", () => {
  it("retries retryable errors and gives up after attempts", async () => {
    let n = 0;
    const fn = async () => { n++; throw new AdapterError({ vendor: "hcp", code: "rate_limited", retryable: true }); };
    await expect(withRetry(fn, { attempts: 3, baseMs: 1, maxMs: 2 })).rejects.toMatchObject({ code: "rate_limited" });
    expect(n).toBe(3);
  });
  it("does not retry non-retryable errors", async () => {
    let n = 0;
    const fn = async () => { n++; throw new AdapterError({ vendor: "hcp", code: "bad", retryable: false }); };
    await expect(withRetry(fn, { attempts: 3, baseMs: 1 })).rejects.toBeDefined();
    expect(n).toBe(1);
  });
});
