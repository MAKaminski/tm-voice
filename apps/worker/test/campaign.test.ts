import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { account, callTask, campaign, contact, seed } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import type { Ctx } from "../src/context.js";
import { apolloSyncCampaign, dialRequeue, toE164 } from "../src/processors/campaign.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const envelope = { entity_id: "x", idempotency_key: "k", attempt: 0, enqueued_at: new Date().toISOString() };
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
let ctx: Ctx;

/** Stands in for Apollo's saved-search response. */
let people: { id: string; phone?: string; first_name?: string; last_name?: string; email?: string; organization_id?: string }[] = [];

beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db);
  const adapters = createAdapters(cfg);
  ctx = {
    cfg, db: t.db, producer: createProducer(undefined, async () => {}),
    adapters: { ...adapters, apollo: { ...adapters.apollo, async listSavedSearchContacts() { return people; } } } as typeof adapters,
  };
  await t.db.update(campaign).set({ status: "active", apolloSavedSearchId: "label_1" }).where(eq(campaign.id, r.campaign.id));
});
afterAll(() => t.close());

describe("toE164", () => {
  it("accepts the shapes a CRM actually stores", () => {
    expect(toE164("(404) 555-0100")).toBe("+14045550100");
    expect(toE164("404-555-0100")).toBe("+14045550100");
    expect(toE164("14045550100")).toBe("+14045550100");
    expect(toE164("+14045550100")).toBe("+14045550100");
    expect(toE164("+442075550100")).toBe("+442075550100");
  });
  it("refuses anything ambiguous rather than guessing", () => {
    for (const bad of [undefined, "", "555-0100", "12345", "ext. 402", "404555010012345"]) {
      expect(toE164(bad)).toBeNull();
    }
  });
});

describe("apolloSyncCampaign", () => {
  it("creates account, contact and call_task from a saved search", async () => {
    people = [{ id: "apollo_c1", phone: "(470) 555-0900", first_name: "Nina", last_name: "Reyes", email: "nina@pm.co", organization_id: "apollo_org1" }];
    const stats = await apolloSyncCampaign(ctx, { ...envelope, campaign_id: r.campaign.id }) as { contacts: number; tasks: number };
    expect(stats).toMatchObject({ campaigns: 1, contacts: 1, tasks: 1 });

    const [c] = await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_c1"));
    expect(c?.phoneE164).toBe("+14705550900");
    // Never trusted from the CRM — the gate's carrier lookup owns it.
    expect(c?.lineType).toBe("unknown");
    const [a] = await t.db.select().from(account).where(eq(account.apolloAccountId, "apollo_org1"));
    expect(a?.id).toBe(c?.accountId);
    const tasks = await t.db.select().from(callTask).where(eq(callTask.contactId, c!.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("queued");
  });

  it("is idempotent: a second run adds no duplicate contact, account or task", async () => {
    const stats = await apolloSyncCampaign(ctx, { ...envelope, campaign_id: r.campaign.id }) as { contacts: number; tasks: number };
    expect(stats).toMatchObject({ contacts: 0, tasks: 0 });
    const [c] = await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_c1"));
    expect(await t.db.select().from(callTask).where(eq(callTask.contactId, c!.id))).toHaveLength(1);
    expect(await t.db.select().from(account).where(eq(account.apolloAccountId, "apollo_org1"))).toHaveLength(1);
  });

  it("shares one account across contacts from the same organization", async () => {
    people = [
      { id: "apollo_c1", phone: "4705550900", organization_id: "apollo_org1" },
      { id: "apollo_c2", phone: "4705550901", organization_id: "apollo_org1" },
    ];
    await apolloSyncCampaign(ctx, { ...envelope, campaign_id: r.campaign.id });
    const rows = await t.db.select().from(account).where(eq(account.apolloAccountId, "apollo_org1"));
    expect(rows).toHaveLength(1);
    const [c2] = await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_c2"));
    expect(c2?.accountId).toBe(rows[0]!.id);
  });

  it("forces a fresh carrier check when the CRM phone number changes", async () => {
    const [before] = await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_c2"));
    await t.db.update(contact).set({ lineType: "landline", lineTypeCheckedAt: new Date() }).where(eq(contact.id, before!.id));
    people = [{ id: "apollo_c2", phone: "4045550999", organization_id: "apollo_org1" }];
    await apolloSyncCampaign(ctx, { ...envelope, campaign_id: r.campaign.id });
    const [after] = await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_c2"));
    expect(after?.phoneE164).toBe("+14045550999");
    expect(after?.lineType).toBe("unknown");
    expect(after?.lineTypeCheckedAt).toBeNull();
  });

  it("counts unusable numbers instead of inventing them", async () => {
    people = [{ id: "apollo_bad", phone: "ext 4021", organization_id: "apollo_org2" }];
    const stats = await apolloSyncCampaign(ctx, { ...envelope, campaign_id: r.campaign.id }) as { skipped_no_phone: number; contacts: number };
    expect(stats.skipped_no_phone).toBe(1);
    expect(stats.contacts).toBe(0);
    expect(await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_bad"))).toHaveLength(0);
  });

  it("skips a campaign with no saved search configured", async () => {
    await t.db.update(campaign).set({ apolloSavedSearchId: null }).where(eq(campaign.id, r.campaign.id));
    const stats = await apolloSyncCampaign(ctx, { ...envelope, campaign_id: r.campaign.id }) as { campaigns: number };
    expect(stats.campaigns).toBe(0);
    await t.db.update(campaign).set({ apolloSavedSearchId: "label_1" }).where(eq(campaign.id, r.campaign.id));
  });
});

describe("dialRequeue", () => {
  it("re-queues timing refusals and leaves verdicts about the contact blocked", async () => {
    const [c] = await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_c1"));
    const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, c!.id));
    await t.db.update(callTask).set({ status: "blocked", gateResult: "window" }).where(eq(callTask.id, task!.id));
    const [c2] = await t.db.select().from(contact).where(eq(contact.apolloContactId, "apollo_c2"));
    const [task2] = await t.db.select().from(callTask).where(eq(callTask.contactId, c2!.id));
    await t.db.update(callTask).set({ status: "blocked", gateResult: "suppressed" }).where(eq(callTask.id, task2!.id));

    const res = await dialRequeue(ctx, envelope) as { requeued: number };
    expect(res.requeued).toBeGreaterThanOrEqual(1);
    const [reopened] = await t.db.select().from(callTask).where(eq(callTask.id, task!.id));
    expect(reopened?.status).toBe("queued");
    expect(reopened?.gateResult).toBeNull();
    const [stillBlocked] = await t.db.select().from(callTask).where(eq(callTask.id, task2!.id));
    expect(stillBlocked?.status).toBe("blocked");
  });
});
