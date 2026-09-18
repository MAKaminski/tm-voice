import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { callTask, campaign, consentEvent, contact, seed } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { createApp } from "../src/app.js";
import { createProducer } from "../src/queue.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123", NODE_ENV: "test", VAPI_ASSISTANT_ID: "asst_joe" });
let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
const enqueued: { queue: string; name: string }[] = [];

beforeAll(async () => {
  t = await createTestDb();
  await seed(t.db);
  app = createApp({
    cfg, db: t.db, adapters: createAdapters(cfg),
    producer: createProducer(undefined, async (queue, name) => { enqueued.push({ queue, name }); }),
  });
});
afterAll(() => t.close());

const auth = { authorization: `Bearer ${cfg.INTERNAL_API_TOKEN}`, "content-type": "application/json" };
const post = (body: unknown) => app.request("/test-calls", { method: "POST", headers: auth, body: JSON.stringify(body) });
const ok = { phone: "+14045550143", attestation: true, attested_by: "Michael Kaminski" };

describe("POST /test-calls", () => {
  it("refuses without the internal token, so the dialer is not an open endpoint", async () => {
    const res = await app.request("/test-calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ok) });
    expect(res.status).toBe(401);
  });

  /**
   * The attestation is what writes the consent grant. If it could be omitted the route would be a
   * way to dial a mobile with no consent record at all, which is the exact thing the gate exists
   * to prevent.
   */
  it("refuses without the attestation", async () => {
    const res = await post({ phone: "+14045550144", attested_by: "Michael" });
    expect(res.status).toBe(400);
  });

  it("refuses a number that is not E.164 rather than coercing it", async () => {
    for (const phone of ["4045550143", "+1 404 555 0143", "not-a-number", "+0445550143"]) {
      expect((await post({ ...ok, phone })).status).toBe(400);
    }
  });

  it("creates the contact, an auditable consent grant, a queued task, and enqueues one dial", async () => {
    const before = enqueued.length;
    const res = await post(ok);
    expect(res.status).toBe(202);

    const [ct] = await t.db.select().from(contact).where(eq(contact.phoneE164, ok.phone));
    expect(ct).toBeDefined();

    const [grant] = await t.db.select().from(consentEvent).where(eq(consentEvent.contactId, ct!.id));
    expect(grant!.eventType).toBe("grant");
    expect(grant!.channel).toBe("console_test_attestation");
    // The provenance is the point: a grant with no record of who asserted it is not evidence.
    expect(grant!.captureArtifact).toMatchObject({ attested_by: "Michael Kaminski", source: "console test-call form" });

    const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, ct!.id));
    expect(task!.status).toBe("queued");

    // The campaign must be active or gateAndClaim will never claim the task.
    const [camp] = await t.db.select().from(campaign).where(eq(campaign.id, task!.campaignId));
    expect(camp!.status).toBe("active");

    expect(enqueued.slice(before)).toEqual([{ queue: "dial", name: "claim" }]);
  });

  it("carries a chosen assistant onto the task, and leaves it null when omitted so Joe is used", async () => {
    await post({ ...ok, phone: "+14045550145", assistant_id: "asst_other" });
    const [withPick] = await t.db.select().from(contact).where(eq(contact.phoneE164, "+14045550145"));
    const [pickedTask] = await t.db.select().from(callTask).where(eq(callTask.contactId, withPick!.id));
    expect(pickedTask!.assistantId).toBe("asst_other");

    const [dflt] = await t.db.select().from(contact).where(eq(contact.phoneE164, ok.phone));
    const [dfltTask] = await t.db.select().from(callTask).where(eq(callTask.contactId, dflt!.id));
    expect(dfltTask!.assistantId).toBeNull();
  });

  /**
   * call_task is unique on (campaign, contact). Re-testing the same number is the common case, so
   * it has to reset the existing row rather than fail — and it must not write a second consent
   * grant, because consent_event is append-only and one attestation is one grant.
   */
  it("re-testing the same number resets the task and does not duplicate the consent grant", async () => {
    const [ct] = await t.db.select().from(contact).where(eq(contact.phoneE164, ok.phone));
    await t.db.update(callTask).set({ status: "done", attemptNo: 3 }).where(eq(callTask.contactId, ct!.id));

    expect((await post(ok)).status).toBe(202);

    const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, ct!.id));
    expect(task!.status).toBe("queued");
    expect(task!.attemptNo).toBe(0);
    expect(await t.db.select().from(consentEvent).where(eq(consentEvent.contactId, ct!.id))).toHaveLength(1);
  });
});

describe("GET /calls and /call-tasks", () => {
  it("both require the internal token", async () => {
    expect((await app.request("/calls")).status).toBe(401);
    expect((await app.request("/call-tasks")).status).toBe(401);
  });

  it("lists the queued test task so a gate-blocked call is not invisible", async () => {
    const res = await app.request("/call-tasks", { headers: auth });
    const j = (await res.json()) as { tasks: { phoneE164: string; status: string }[] };
    expect(res.status).toBe(200);
    expect(j.tasks.some((t) => t.phoneE164 === ok.phone)).toBe(true);
  });

  it("returns an empty call log rather than erroring when nothing has been dialled", async () => {
    const res = await app.request("/calls", { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()) as { calls: unknown[] }).toHaveProperty("calls");
  });
});
