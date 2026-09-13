import { describe, expect, it } from "vitest";
import { bullJobId, idempotencyKey } from "../src/index.js";

describe("bullJobId", () => {
  it("removes every colon, which BullMQ rejects in a custom job id", () => {
    const key = idempotencyKey("dial", "f214a9ca-dae4-4db3-b006-5e4bab847d0b", "2026-09-13T20:10:00.000Z");
    expect(bullJobId(key)).not.toContain(":");
  });

  it("is injective: keys differing only by an escaped character stay distinct", () => {
    expect(bullJobId("a:b")).not.toBe(bullJobId("a%3Ab"));
    expect(bullJobId("a%b")).toBe("a%25b");
  });

  it("leaves a colon-free key unchanged", () => {
    expect(bullJobId("email.booking_confirmation.123")).toBe("email.booking_confirmation.123");
  });

});
