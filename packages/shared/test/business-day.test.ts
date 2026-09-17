import { describe, expect, it } from "vitest";
import { DEFAULT_DIAL_TIMEZONE, startOfLocalDay } from "../src/index.js";

const iso = (d: Date) => d.toISOString();

describe("where the dialer's day starts", () => {
  it("is Eastern, not UTC", () => {
    expect(DEFAULT_DIAL_TIMEZONE).toBe("America/New_York");
  });

  it("does not roll over mid-afternoon, which is the bug this fixes", () => {
    // 2026-09-17 21:00 UTC = 17:00 EDT. Under the old UTC-midnight boundary the "day" had
    // already rolled at 20:00 EDT, so a 10/day cap could place 10 more dials before bedtime.
    const afternoon = new Date("2026-09-17T21:00:00Z");
    expect(iso(startOfLocalDay(afternoon))).toBe("2026-09-17T04:00:00.000Z"); // 00:00 EDT
  });

  it("puts an instant just before local midnight in the day that is ending", () => {
    // 03:59 UTC on the 18th is 23:59 EDT on the 17th.
    expect(iso(startOfLocalDay(new Date("2026-09-18T03:59:00Z")))).toBe("2026-09-17T04:00:00.000Z");
  });

  it("puts an instant just after local midnight in the new day", () => {
    expect(iso(startOfLocalDay(new Date("2026-09-18T04:01:00Z")))).toBe("2026-09-18T04:00:00.000Z");
  });

  it("tracks the DST change instead of drifting an hour twice a year", () => {
    // EDT (UTC-4) in September, EST (UTC-5) in December.
    expect(iso(startOfLocalDay(new Date("2026-09-17T18:00:00Z")))).toBe("2026-09-17T04:00:00.000Z");
    expect(iso(startOfLocalDay(new Date("2026-12-17T18:00:00Z")))).toBe("2026-12-17T05:00:00.000Z");
  });

  it("honours a different market's timezone", () => {
    expect(iso(startOfLocalDay(new Date("2026-09-17T21:00:00Z"), "America/Los_Angeles"))).toBe("2026-09-17T07:00:00.000Z");
    expect(iso(startOfLocalDay(new Date("2026-09-17T21:00:00Z"), "UTC"))).toBe("2026-09-17T00:00:00.000Z");
  });
});
