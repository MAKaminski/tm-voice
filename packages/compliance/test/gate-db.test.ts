import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters, MOCK_DNC_NUMBERS } from "@tm/adapters";
import { callTask, consentEvent, contact, seed, SEED } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { gateAndClaim } from "../src/gate.js";
import { recordGrant } from "../src/consent.js";
import { suppress } from "../src/suppression.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const NOON = new Date("2026-09-10T14:00:00Z");
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
const adapters = createAdapters(cfg);
const byPhone = (p: string) => r.contacts.find((c) => c.phoneE164 === p)!;

beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db, { day: new Date("2026-09-11T00:00:00Z") });
  // Make Tom (CT) a DNC hit so the fixture covers that branch.
  MOCK_DNC_NUMBERS.add(SEED.phones.landlineCt);
});
afterAll(() => t.close());

async function claimFor(phone: string, c = cfg, now = NOON) {
  const id = byPhone(phone).id;
  // Restrict to this contact by bumping every other task's earliest_dial_at into the future.
  const future = new Date("2099-01-01");
  await t.db.update(callTask).set({ earliestDialAt: future }).where(and(eq(callTask.status, "queued")));
  await t.db.update(callTask).set({ earliestDialAt: new Date("2026-01-01") }).where(eq(callTask.contactId, id));
  return gateAndClaim(t.db, adapters, c, { didId: r.did.id, now });
}

describe("gateAndClaim (SKIP LOCKED + same-transaction gate_result)", () => {
  it("landline GA passes and is claimed", async () => {
    const res = await claimFor(SEED.phones.landlineGa);
    expect(res?.outcome.result).toBe("pass");
    expect(res?.task.status).toBe("claimed");
    expect(res?.task.attemptNo).toBe(1);
    expect(res?.task.gateResult).toBe("pass");
  });
  it("wireless GA → surface under landline_only, and stays blocked", async () => {
    const res = await claimFor(SEED.phones.wirelessGa);
    expect(res?.outcome.result).toBe("surface");
    expect(res?.task.status).toBe("blocked");
  });
  it("suppressed number → suppressed", async () => {
    expect((await claimFor(SEED.phones.suppressed))?.outcome.result).toBe("suppressed");
  });
  it("DNC hit → dnc and caches on the contact", async () => {
    expect((await claimFor(SEED.phones.landlineCt))?.outcome.result).toBe("dnc");
    const [c] = await t.db.select().from(contact).where(eq(contact.phoneE164, SEED.phones.landlineCt));
    expect(c?.dncFederal).toBe(true);
    expect(c?.dncCheckedAt).not.toBeNull();
  });
  it("FL at 20:30 local → window", async () => {
    expect((await claimFor(SEED.phones.landlineFl, cfg, new Date("2026-09-11T00:30:00Z")))?.outcome.result).toBe("window");
  });
  it("MA → surface by default", async () => {
    expect((await claimFor(SEED.phones.landlineMa))?.outcome.result).toBe("surface");
  });
  it("returns null when nothing is queued", async () => {
    await t.db.update(callTask).set({ earliestDialAt: new Date("2099-01-01") });
    expect(await gateAndClaim(t.db, adapters, cfg, { didId: r.did.id, now: NOON })).toBeNull();
  });
});

describe("consent + suppression", () => {
  it("wireless with a grant passes under consented_mobile", async () => {
    const marcus = byPhone(SEED.phones.wirelessGa);
    await t.db.update(callTask).set({ status: "queued", gateResult: null }).where(eq(callTask.contactId, marcus.id));
    await recordGrant(t.db, { contactId: marcus.id, channel: "web", artifact: { form: "consent-v1", ip: "127.0.0.1" } });
    const res = await claimFor(SEED.phones.wirelessGa, { ...cfg, COMPLIANCE_TARGET_SURFACE: "consented_mobile" });
    expect(res?.outcome.result).toBe("pass");
  });
  it("suppress() writes SUPPRESSION + CONSENT_EVENT(revoke) and a later grant is now older", async () => {
    const marcus = byPhone(SEED.phones.wirelessGa);
    const out = await suppress(t.db, { phoneE164: SEED.phones.wirelessGa, reason: "said stop", channel: "phone" });
    expect(out).toEqual({ suppressed: true, revokedContacts: 1 });
    const evs = await t.db.select().from(consentEvent).where(eq(consentEvent.contactId, marcus.id));
    expect(evs.map((e) => e.eventType).sort()).toEqual(["grant", "revoke"]);
    // second call is a no-op on SUPPRESSION but still appends a revoke (ledger, not state)
    expect((await suppress(t.db, { phoneE164: SEED.phones.wirelessGa, reason: "again", channel: "manual" })).suppressed).toBe(false);
    await t.db.update(callTask).set({ status: "queued", gateResult: null }).where(eq(callTask.contactId, marcus.id));
    // Surface runs before suppression: the revoke now outranks the grant, so the gate reports 'surface'.
    expect((await claimFor(SEED.phones.wirelessGa, { ...cfg, COMPLIANCE_TARGET_SURFACE: "consented_mobile" }))?.outcome.result).toBe("surface");
    // A landline carrying a suppressed number reports 'suppressed'.
    await t.db.update(contact).set({ lineType: "landline" }).where(eq(contact.id, marcus.id));
    await t.db.update(callTask).set({ status: "queued", gateResult: null }).where(eq(callTask.contactId, marcus.id));
    expect((await claimFor(SEED.phones.wirelessGa))?.outcome.result).toBe("suppressed");
  });
});
