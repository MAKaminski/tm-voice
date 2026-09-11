import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://x", INTERNAL_API_TOKEN: "0123456789abcdef0123" };

describe("config loader", () => {
  it("allows missing vendor keys in dry_run", () => {
    const c = loadConfig({ ...base });
    expect(c.DIAL_MODE).toBe("dry_run");
    expect(c.COMPLIANCE_TARGET_SURFACE).toBe("landline_only");
    expect(c.AUTO_BOOK).toBe(false);
  });
  it("fails fast listing missing keys outside dry_run", () => {
    expect(() => loadConfig({ ...base, DIAL_MODE: "live", REDIS_URL: "redis://x" })).toThrow(/missing: APOLLO_API_KEY/);
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
  it("still names a blank vendor key as missing outside dry_run", () => {
    expect(() => loadConfig({ ...base, DIAL_MODE: "live", REDIS_URL: "redis://x", LLM_PROVIDER: "" })).toThrow(
      /missing:.*LLM_PROVIDER/,
    );
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
