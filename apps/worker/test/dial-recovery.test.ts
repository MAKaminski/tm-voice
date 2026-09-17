import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { SEED, call, callTask, campaign, seed } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { AdapterError, loadConfig } from "@tm/shared";
import type { Ctx } from "../src/context.js";
import { CLAIM_STALE_MS, dialRequeue } from "../src/processors/campaign.js";
import { dialClaim } from "../src/processors/dial.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const env = { entity_id: "x", idempotency_key: "k", attempt: 0, enqueued_at: new Date().toISOString() };

/** Outside 08:00–21:00 ET the gate legitimately answers 'window', so these assertions would be noise. */
const inWindow = () => {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())) % 24;
  return h >= 8 && h < 21;
};

let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
let ctx: Ctx;

/** The one landline task the gate will pass; everything else pushed out of reach. */
async function onlyDanaEligible() {
  await t.db.update(callTask).set({ earliestDialAt: new Date("2099-01-01"), status: "queued", attemptNo: 0, claimedAt: null, gateResult: null });
  const dana = r.contacts.find((x) => x.phoneE164 === SEED.phones.landlineGa)!;
  await t.db.update(callTask).set({ earliestDialAt: new Date("2020-01-01") }).where(eq(callTask.contactId, dana.id));
  const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, dana.id));
  return task!;
}

beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db);
  ctx = { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) };
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.update(campaign).set({ status: "active" });
  await t.db.delete(call);
});

describe("a dial that fails after the task was claimed", () => {
  it.runIf(inWindow())("returns the task to queued and refunds the attempt", async () => {
    const before = await onlyDanaEligible();
    expect(before.attemptNo).toBe(0);

    // What the first real dial does until a DID is imported into Vapi.
    const broken = { ...ctx, adapters: { ...ctx.adapters, vapi: {
      ...ctx.adapters.vapi,
      createOutboundCall: async () => { throw new AdapterError({ vendor: "vapi", code: "unknown_from_number", retryable: false }); },
    } } } as Ctx;

    await expect(dialClaim(broken, { ...env })).rejects.toMatchObject({ code: "unknown_from_number" });

    const [after] = await t.db.select().from(callTask).where(eq(callTask.id, before.id));
    // Without the fix this row would sit in 'claimed' forever with attemptNo 1 — the contact
    // silently dropped, invisible to dial.requeue.
    expect(after).toMatchObject({ status: "queued", attemptNo: 0, gateResult: null, claimedAt: null });
    expect(await t.db.select().from(call)).toHaveLength(0);
  });

  it.runIf(inWindow())("re-throws so BullMQ retries rather than swallowing the failure", async () => {
    await onlyDanaEligible();
    const broken = { ...ctx, adapters: { ...ctx.adapters, vapi: {
      ...ctx.adapters.vapi, createOutboundCall: async () => { throw new Error("vendor down"); },
    } } } as Ctx;
    await expect(dialClaim(broken, { ...env })).rejects.toThrow("vendor down");
  });
});

describe("a task abandoned by a worker that died mid-dial", () => {
  it("is recovered once the claim goes stale, with the attempt refunded", async () => {
    const task = await onlyDanaEligible();
    // No catch block can rescue this: the process that claimed it is gone.
    await t.db.update(callTask)
      .set({ status: "claimed", attemptNo: 1, claimedAt: new Date(Date.now() - CLAIM_STALE_MS - 60_000) })
      .where(eq(callTask.id, task.id));

    expect(await dialRequeue(ctx, { ...env })).toMatchObject({ recovered: 1 });
    const [after] = await t.db.select().from(callTask).where(eq(callTask.id, task.id));
    expect(after).toMatchObject({ status: "queued", attemptNo: 0, claimedAt: null });
  });

  it("leaves a fresh claim alone, so a slow vendor call is not mistaken for a dead worker", async () => {
    const task = await onlyDanaEligible();
    await t.db.update(callTask).set({ status: "claimed", attemptNo: 1, claimedAt: new Date() }).where(eq(callTask.id, task.id));

    expect(await dialRequeue(ctx, { ...env })).toMatchObject({ recovered: 0 });
    const [after] = await t.db.select().from(callTask).where(eq(callTask.id, task.id));
    expect(after!.status).toBe("claimed");
  });
});

describe("pausing a campaign", () => {
  it.runIf(inWindow())("actually stops it dialling, even via a replayed claim", async () => {
    await onlyDanaEligible();
    // dial.tick filters on active campaigns, but a replayed dial.claim does not go through it.
    await t.db.update(campaign).set({ status: "paused" });

    expect(await dialClaim(ctx, { ...env })).toEqual({ skipped: "nothing_queued" });
    expect(await t.db.select().from(call)).toHaveLength(0);
  });

  it.runIf(inWindow())("resumes when the campaign goes active again", async () => {
    await onlyDanaEligible();
    await t.db.update(campaign).set({ status: "active" });
    const out = await dialClaim(ctx, { ...env }) as { gate_result?: string };
    expect(out.gate_result).toBe("pass");
  });
});
