import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../src/test-db.js";
import { seed, SEED } from "../src/seed-data.js";
import * as s from "../src/schema.js";

async function rejectsWith(p: Promise<unknown>, re: RegExp) {
  try { await p; } catch (e) {
    const err = e as Error & { cause?: Error };
    const msg = `${err.message}\n${err.cause?.message ?? ""}`;
    expect(msg).toMatch(re);
    return;
  }
  throw new Error(`expected rejection matching ${re}`);
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => { t = await createTestDb(); r = await seed(t.db, { day: new Date("2026-09-10T00:00:00Z") }); });
afterAll(() => t.close());

describe("schema invariants", () => {
  it("seeds 17 tables worth of fixtures", async () => {
    expect(r.contacts).toHaveLength(6);
    expect(r.tasks).toHaveLength(6);
  });
  it("consent_event rejects UPDATE", async () => {
    const [ev] = await t.db.insert(s.consentEvent).values({ contactId: r.contacts[0]!.id, eventType: "grant", channel: "web" }).returning();
    await rejectsWith(t.db.update(s.consentEvent).set({ channel: "phone" }).where(eq(s.consentEvent.id, ev!.id)), /append-only/);
  });
  it("consent_event rejects DELETE", async () => {
    const [ev] = await t.db.insert(s.consentEvent).values({ contactId: r.contacts[0]!.id, eventType: "revoke", channel: "phone" }).returning();
    await rejectsWith(t.db.delete(s.consentEvent).where(eq(s.consentEvent.id, ev!.id)), /append-only/);
  });
  it("suppression is unique on phone_e164", async () => {
    await rejectsWith(t.db.insert(s.suppression).values({ phoneE164: SEED.phones.suppressed, reason: "dup" }), /unique|duplicate/i);
  });
  it("recording.retain_until must be >= 5 years", async () => {
    const [c] = await t.db.insert(s.call).values({ callTaskId: r.tasks[0]!.id, disposition: "dry_run" }).returning();
    await rejectsWith(t.db.insert(s.recording).values({ callId: c!.id, r2Key: "x", retainUntil: "2027-01-01" }), /recording_retain_5y/);
    await expect(t.db.insert(s.recording).values({ callId: c!.id, r2Key: "x", retainUntil: "2031-09-09" })).resolves.toBeDefined();
  });
});
