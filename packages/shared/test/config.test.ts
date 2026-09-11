import { describe, expect, it } from "vitest";
import { DIAL_PATH_VENDOR_KEYS, loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://x", INTERNAL_API_TOKEN: "0123456789abcdef0123" };

describe("config loader", () => {
  it("allows missing vendor keys in dry_run", () => {
    const c = loadConfig({ ...base });
    expect(c.DIAL_MODE).toBe("dry_run");
    expect(c.COMPLIANCE_TARGET_SURFACE).toBe("landline_only");
    expect(c.AUTO_BOOK).toBe(false);
  });
  it("fails fast naming the missing dial-path keys outside dry_run", () => {
    expect(() => loadConfig({ ...base, DIAL_MODE: "live", REDIS_URL: "redis://x" })).toThrow(/missing: TELNYX_API_KEY/);
  });
  it("outside dry_run requires only the dial path, not all 25 keys", () => {
    // A first live call should not depend on Graph certs, R2 tokens or a Resend domain.
    const dialPath = Object.fromEntries(DIAL_PATH_VENDOR_KEYS.map((k) => [k, "x"]));
    const c = loadConfig({ ...base, DIAL_MODE: "live", REDIS_URL: "redis://x", ...dialPath });
    expect(c.DIAL_MODE).toBe("live");
    expect(c.HCP_API_KEY).toBeUndefined();
    expect(c.R2_BUCKET).toBeUndefined();
  });
  it("requires all three telnyx keys together so a partial config cannot fail open", () => {
    // The telnyx mock resolves most numbers to "landline", the only value landline_only accepts.
    const partial = { TELNYX_API_KEY: "x", VAPI_PRIVATE_KEY: "x", VAPI_WEBHOOK_SECRET: "x", VAPI_ASSISTANT_ID: "x", DNC_API_KEY: "x" };
    expect(() => loadConfig({ ...base, DIAL_MODE: "live", REDIS_URL: "redis://x", ...partial }))
      .toThrow(/TELNYX_CONNECTION_ID/);
  });
  it("requires an allowlist for verified_only", () => {
    expect(() => loadConfig({ ...base, DIAL_MODE: "verified_only" })).toThrow(/DIAL_ALLOWLIST/);
  });
  it("treats a blank vendor key as unset in dry_run", () => {
    // Railway passes a declared-but-empty variable as ""; env.example ships them blank.
    const c = loadConfig({ ...base, LLM_PROVIDER: "", LLM_MODEL: "   ", APOLLO_API_KEY: "" });
    expect(c.LLM_PROVIDER).toBeUndefined();
    expect(c.LLM_MODEL).toBeUndefined();
    expect(c.APOLLO_API_KEY).toBeUndefined();
  });
  it("still names a blank dial-path key as missing outside dry_run", () => {
    const dialPath = Object.fromEntries(DIAL_PATH_VENDOR_KEYS.map((k) => [k, "x"]));
    expect(() => loadConfig({ ...base, DIAL_MODE: "live", REDIS_URL: "redis://x", ...dialPath, DNC_API_KEY: "" }))
      .toThrow(/missing:.*DNC_API_KEY/);
  });
  it("treats a blank switch as unset so its default applies", () => {
    const c = loadConfig({ ...base, AUTO_BOOK: "", DIAL_MODE: "", COMPLIANCE_TARGET_SURFACE: "" });
    expect(c.AUTO_BOOK).toBe(false);
    expect(c.DIAL_MODE).toBe("dry_run");
    expect(c.COMPLIANCE_TARGET_SURFACE).toBe("landline_only");
  });
  it("parses DIAL_ALLOWLIST", () => {
    expect(loadConfig({ ...base, DIAL_ALLOWLIST: "+14045550100, +14045550101" }).DIAL_ALLOWLIST).toEqual(["+14045550100", "+14045550101"]);
  });
});
