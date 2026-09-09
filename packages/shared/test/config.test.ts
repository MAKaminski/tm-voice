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
  it("parses DIAL_ALLOWLIST", () => {
    expect(loadConfig({ ...base, DIAL_ALLOWLIST: "+14045550100, +14045550101" }).DIAL_ALLOWLIST).toEqual(["+14045550100", "+14045550101"]);
  });
});
