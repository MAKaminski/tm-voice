import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { account, call, callTask, contact, recording, retainUntil, seed, transcript } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APOLLO_STATUS, apolloLogCall, buildNote } from "../src/processors/apollo-log.js";
import type { Ctx } from "../src/context.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const env = (id: string) => ({ entity_id: id, idempotency_key: `apollo:logCall:${id}`, attempt: 0, enqueued_at: new Date().toISOString() });

let t: Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let taskId: string;
let didId: string;

/** A completed call, the state postcall.process leaves behind. */
async function completedCall(vapiId: string, over: Partial<typeof call.$inferInsert> = {}) {
  const [c] = await t.db.insert(call).values({
    callTaskId: taskId, didId, vapiCallId: vapiId,
    startedAt: new Date("2026-09-17T14:00:00Z"), endedAt: new Date("2026-09-17T14:02:30Z"),
    durationSec: 150, disposition: "callback", ...over,
  }).returning();
  return c!;
}

beforeAll(async () => {
  t = await createTestDb();
  const r = await seed(t.db);
  ctx = { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) };
  const [task] = await t.db.select().from(callTask).limit(1);
  taskId = task!.id;
  didId = r.did.id;
});
afterAll(() => t.close());
beforeEach(async () => { await t.db.delete(recording); await t.db.delete(transcript); await t.db.delete(call); });

describe("the note", () => {
  it("carries the outcome, the summary and a link, because Apollo has a field for none of them", () => {
    const note = buildNote({ disposition: "callback", summary: "Asked us to try Thursday.", recordingUrl: "https://r2/x", disclosureOk: true });
    expect(note).toContain("Outcome: callback.");
    expect(note).toContain("Asked us to try Thursday.");
    expect(note).toContain("Recording (expires in 7 days): https://r2/x");
  });

  it("flags a rule 10 exception where the person following up will see it", () => {
    expect(buildNote({ disposition: "callback", summary: null, recordingUrl: null, disclosureOk: false }))
      .toContain("disclosure line was not spoken verbatim");
  });

  it("says nothing about the disclosure when it was fine or unassessed", () => {
    for (const ok of [true, null]) {
      expect(buildNote({ disposition: "booked", summary: null, recordingUrl: null, disclosureOk: ok }))
        .not.toContain("disclosure line");
    }
  });

  it("stays inside Apollo's 10k note limit", () => {
    expect(buildNote({ disposition: "booked", summary: "x".repeat(20_000), recordingUrl: null, disclosureOk: null }).length).toBe(10_000);
  });
});

describe("the status mapping", () => {
  it("covers every disposition, so a new one cannot silently log as undefined", () => {
    const dispositions = ["dry_run", "booked", "callback", "not_interested", "opt_out", "voicemail", "no_answer", "busy", "failed", "wrong_number"] as const;
    for (const d of dispositions) expect(APOLLO_STATUS[d]).toBeTruthy();
  });
});

describe("apollo.logCall", () => {
  it("logs the call and records the id, so a replay can tell it already happened", async () => {
    const c = await completedCall("vapi_al_1");
    await t.db.insert(transcript).values({ callId: c.id, turns: [], summary: "Asked us to try Thursday." });

    const out = await apolloLogCall(ctx, { ...env(c.id), vapi_call_id: "vapi_al_1" }) as { apollo_phone_call_id: string };
    expect(out.apollo_phone_call_id).toBeTruthy();

    const logged = ctx.adapters.apollo.mock!.calls.filter((x) => x.method === "logPhoneCall");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.args[0]).toMatchObject({
      to_number: "+14045550100", from_number: "+14045550000",
      status: "Completed", duration: 150,
      start_time: "2026-09-17T14:00:00.000Z", end_time: "2026-09-17T14:02:30.000Z",
    });
    // Apollo's outcome ids are per-workspace and we have none, so this is deliberately absent —
    // a wrong id would file the call under someone else's taxonomy.
    expect(logged[0]!.args[0]).not.toHaveProperty("phone_call_outcome_id");

    const [after] = await t.db.select().from(call).where(eq(call.id, c.id));
    expect(after!.apolloPhoneCallId).toBe(out.apollo_phone_call_id);
  });

  it("includes a signed recording link when there is a recording", async () => {
    const c = await completedCall("vapi_al_2");
    await t.db.insert(recording).values({ callId: c.id, r2Key: "calls/2026/09/x.wav", retainUntil: retainUntil(new Date()) });

    await apolloLogCall(ctx, { ...env(c.id), vapi_call_id: "vapi_al_2" });
    const note = String((ctx.adapters.apollo.mock!.calls.at(-1)!.args[0] as { note: string }).note);
    expect(note).toContain("Recording (expires in 7 days): https://mock-r2.local/calls/2026/09/x.wav");
  });

  it("logs the call anyway when the link cannot be signed", async () => {
    const c = await completedCall("vapi_al_3");
    await t.db.insert(recording).values({ callId: c.id, r2Key: "calls/2026/09/y.wav", retainUntil: retainUntil(new Date()) });
    const broken = { ...ctx, adapters: { ...ctx.adapters, r2: {
      ...ctx.adapters.r2, getSignedUrl: async () => { throw new Error("no r2 keys"); },
    } } } as Ctx;

    // A missing link is worth less than a missing activity on the contact.
    await expect(apolloLogCall(broken, { ...env(c.id), vapi_call_id: "vapi_al_3" })).resolves.toMatchObject({ call_id: c.id });
  });

  it("does not log twice", async () => {
    const c = await completedCall("vapi_al_4");
    await apolloLogCall(ctx, { ...env(c.id), vapi_call_id: "vapi_al_4" });
    const before = ctx.adapters.apollo.mock!.calls.filter((x) => x.method === "logPhoneCall").length;

    const second = await apolloLogCall(ctx, { ...env(c.id), vapi_call_id: "vapi_al_4" });
    expect(second).toMatchObject({ skipped: "already_logged" });
    expect(ctx.adapters.apollo.mock!.calls.filter((x) => x.method === "logPhoneCall").length).toBe(before);
  });

  it("waits rather than logging a call that has no disposition yet", async () => {
    const c = await completedCall("vapi_al_5", { disposition: null });
    expect(await apolloLogCall(ctx, { ...env(c.id), vapi_call_id: "vapi_al_5" })).toMatchObject({ skipped: "no_disposition_yet" });
  });

  it("refuses to report a from-number it does not have", async () => {
    const c = await completedCall("vapi_al_6", { didId: null });
    expect(await apolloLogCall(ctx, { ...env(c.id), vapi_call_id: "vapi_al_6" })).toMatchObject({ skipped: "no_did" });
  });

  it("ignores a call we did not place", async () => {
    expect(await apolloLogCall(ctx, { ...env("x"), vapi_call_id: "never" })).toMatchObject({ skipped: "unknown_call" });
  });

  it("passes the Apollo ids through when the contact and account have them", async () => {
    const [ct] = await t.db.select().from(contact).limit(1);
    await t.db.update(contact).set({ apolloContactId: "apollo_c_1" }).where(eq(contact.id, ct!.id));
    await t.db.update(account).set({ apolloAccountId: "apollo_a_1" }).where(eq(account.id, ct!.accountId));
    const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, ct!.id));
    const [c] = await t.db.insert(call).values({
      callTaskId: task!.id, didId, vapiCallId: "vapi_al_7", disposition: "booked",
      startedAt: new Date("2026-09-17T14:00:00Z"), durationSec: 60,
    }).returning();

    await apolloLogCall(ctx, { ...env(c!.id), vapi_call_id: "vapi_al_7" });
    expect(ctx.adapters.apollo.mock!.calls.at(-1)!.args[0]).toMatchObject({ contact_id: "apollo_c_1", account_id: "apollo_a_1" });
  });
});
