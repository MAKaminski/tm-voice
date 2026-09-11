import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { SEED, callTask, contact, seed } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { AdapterError, loadConfig } from "@tm/shared";
import { LINE_TYPE_CACHE_MS, gateAndClaim } from "../src/gate.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const NOON = new Date("2026-09-10T14:00:00Z");
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
const adapters = createAdapters(cfg);

beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db, { day: new Date("2026-09-11T00:00:00Z") });
});
afterAll(() => t.close());

const byPhone = (p: string) => r.contacts.find((c) => c.phoneE164 === p)!;

/** Isolate one contact by pushing every other queued task out of reach. */
async function claimOnly(phone: string, adapterSet = adapters, now = NOON) {
  await t.db.update(callTask).set({ earliestDialAt: new Date("2099-01-01") });
  await t.db.update(callTask).set({ earliestDialAt: new Date("2026-01-01"), status: "queued", gateResult: null })
    .where(eq(callTask.contactId, byPhone(phone).id));
  return gateAndClaim(t.db, adapterSet, cfg, { didId: r.did.id, now });
}

const reload = (phone: string) => t.db.select().from(contact).where(eq(contact.id, byPhone(phone).id)).then((rows) => rows[0]!);

describe("line_type enrichment inside the gate", () => {
  it("resolves an unverified contact via the carrier lookup and stamps the check", async () => {
    await t.db.update(contact).set({ lineType: "unknown", lineTypeCheckedAt: null }).where(eq(contact.id, byPhone(SEED.phones.landlineGa).id));
    const res = await claimOnly(SEED.phones.landlineGa);
    expect(res?.outcome.result).toBe("pass");
    const after = await reload(SEED.phones.landlineGa);
    expect(after.lineType).toBe("landline");
    expect(after.lineTypeCheckedAt).toBeInstanceOf(Date);
    // The claim result reports the resolved value, not the stale 'unknown'.
    expect(res?.contact.lineType).toBe("landline");
  });

  it("an unverified mobile is blocked at the surface check under landline_only", async () => {
    await t.db.update(contact).set({ lineType: "unknown", lineTypeCheckedAt: null }).where(eq(contact.id, byPhone(SEED.phones.wirelessGa).id));
    const res = await claimOnly(SEED.phones.wirelessGa);
    expect(res?.outcome.result).toBe("surface");
    expect((await reload(SEED.phones.wirelessGa)).lineType).toBe("wireless");
  });

  it("does not re-look-up a contact checked inside the cache window", async () => {
    const fresh = new Date(NOON.getTime() - 1000);
    await t.db.update(contact).set({ lineType: "landline", lineTypeCheckedAt: fresh }).where(eq(contact.id, byPhone(SEED.phones.landlineGa).id));
    const before = adapters.telnyx.mock!.calls.filter((x) => x.method === "lookupLineType").length;
    await claimOnly(SEED.phones.landlineGa);
    const after = adapters.telnyx.mock!.calls.filter((x) => x.method === "lookupLineType").length;
    expect(after).toBe(before);
  });

  it("re-looks-up once the stamp is older than the cache window", async () => {
    const stale = new Date(NOON.getTime() - LINE_TYPE_CACHE_MS - 1000);
    await t.db.update(contact).set({ lineType: "landline", lineTypeCheckedAt: stale }).where(eq(contact.id, byPhone(SEED.phones.landlineGa).id));
    const before = adapters.telnyx.mock!.calls.filter((x) => x.method === "lookupLineType").length;
    await claimOnly(SEED.phones.landlineGa);
    const after = adapters.telnyx.mock!.calls.filter((x) => x.method === "lookupLineType").length;
    expect(after).toBe(before + 1);
  });

  it("leaves the task queued when the lookup fails, rather than marking it blocked", async () => {
    await t.db.update(contact).set({ lineType: "unknown", lineTypeCheckedAt: null }).where(eq(contact.id, byPhone(SEED.phones.landlineFl).id));
    const failing = {
      ...adapters,
      telnyx: {
        ...adapters.telnyx,
        async lookupLineType() { throw new AdapterError({ vendor: "telnyx", code: "http_503", retryable: true }); },
      },
    } as typeof adapters;
    await expect(claimOnly(SEED.phones.landlineFl, failing)).rejects.toMatchObject({ code: "http_503" });
    // The transaction rolled back: still queued for the next attempt, and not written off.
    const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, byPhone(SEED.phones.landlineFl).id));
    expect(task?.status).toBe("queued");
    expect(task?.gateResult).toBeNull();
    expect((await reload(SEED.phones.landlineFl)).lineType).toBe("unknown");
  });
});
