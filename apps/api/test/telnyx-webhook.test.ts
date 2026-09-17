import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createAdapters } from "@tm/adapters";
import { SEED, call, callTask, seed } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createProducer } from "../src/queue.js";

/** A real Ed25519 pair, so the route is exercised through the genuine signature check. */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubB64 = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");

// Real mode: the three Telnyx keys present, so verifyWebhook actually verifies rather than
// returning true the way the mock does.
const cfg = loadConfig({
  DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123", NODE_ENV: "test",
  DIAL_MODE: "live", REDIS_URL: "redis://x",
  TELNYX_API_KEY: "k", TELNYX_CONNECTION_ID: "c", TELNYX_PUBLIC_KEY: pubB64,
  VAPI_PRIVATE_KEY: "k", VAPI_WEBHOOK_SECRET: "s", VAPI_ASSISTANT_ID: "a", DNC_API_KEY: "d",
});

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let taskId: string;
let didId: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

function post(body: unknown, over: { ts?: string; sig?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = over.sig ?? cryptoSign(null, Buffer.from(`${ts}|${raw}`, "utf8"), privateKey).toString("base64");
  return app.request("/webhooks/telnyx", {
    method: "POST", body: raw,
    headers: { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts },
  });
}

const event = (eventType: string, payload: Record<string, unknown>) => ({ data: { event_type: eventType, payload } });

beforeAll(async () => {
  t = await createTestDb();
  const r = await seed(t.db);
  app = createApp({ cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) });
  const dana = r.contacts.find((c) => c.phoneE164 === SEED.phones.landlineGa)!;
  const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, dana.id));
  taskId = task!.id;
  didId = r.did.id;
});
afterAll(() => t.close());
beforeEach(async () => { await t.db.delete(call); });

describe("POST /webhooks/telnyx", () => {
  it("existed nowhere before, and now rejects an unsigned delivery", async () => {
    const res = await app.request("/webhooks/telnyx", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects a forged signature", async () => {
    const res = await post(event("call.hangup", { call_control_id: "cc1" }), { sig: "AAAA" });
    expect(res.status).toBe(401);
  });

  it("rejects a replayed delivery outside the five-minute window", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    const res = await post(event("call.hangup", { call_control_id: "cc1" }), { ts: stale });
    expect(res.status).toBe(401);
  });

  it("records the carrier's hangup cause, which Vapi's report does not carry", async () => {
    const [c] = await t.db.insert(call).values({ callTaskId: taskId, didId, vapiCallId: "v1" }).returning();
    const res = await post(event("call.hangup", {
      call_control_id: "cc_hangup", command_id: taskId,
      hangup_cause: "call_rejected", end_time: "2026-09-17T14:02:30Z",
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, matched: 1, event: "call.hangup" });

    const [after] = await t.db.select().from(call).where(eq(call.id, c!.id));
    // "call_rejected" and "no answer" are indistinguishable from Vapi's side; this is the difference.
    expect(after).toMatchObject({ telnyxHangupCause: "call_rejected", telnyxCallControlId: "cc_hangup" });
    expect(after!.endedAt?.toISOString()).toBe("2026-09-17T14:02:30.000Z");
  });

  it("records when the callee actually answered", async () => {
    const [c] = await t.db.insert(call).values({ callTaskId: taskId, didId, vapiCallId: "v2" }).returning();
    await post(event("call.answered", { call_control_id: "cc_ans", command_id: taskId, answered_at: "2026-09-17T14:00:05Z" }));
    const [after] = await t.db.select().from(call).where(eq(call.id, c!.id));
    expect(after!.startedAt.toISOString()).toBe("2026-09-17T14:00:05.000Z");
  });

  it("keeps the carrier's cost apart from Vapi's, rather than summing two vendors' numbers", async () => {
    const [c] = await t.db.insert(call).values({ callTaskId: taskId, didId, vapiCallId: "v3", costUsd: "0.0900" }).returning();
    await post(event("call.hangup", { call_control_id: "cc_cost", command_id: taskId, call_cost: { amount: "0.0042", currency: "USD" } }));
    const [after] = await t.db.select().from(call).where(eq(call.id, c!.id));
    expect(after).toMatchObject({ telnyxCostUsd: "0.0042", costUsd: "0.0900" });
  });

  it("falls back to the control id when there is no usable command id", async () => {
    const [c] = await t.db.insert(call).values({ callTaskId: taskId, didId, vapiCallId: "v4", telnyxCallControlId: "cc_known" }).returning();
    await post(event("call.hangup", { call_control_id: "cc_known", hangup_cause: "normal_clearing" }));
    const [after] = await t.db.select().from(call).where(eq(call.id, c!.id));
    expect(after!.telnyxHangupCause).toBe("normal_clearing");
  });

  it("shrugs at an event for a call we have not recorded yet, since Telnyx can beat our own insert", async () => {
    const res = await post(event("call.hangup", { call_control_id: "cc_unknown", hangup_cause: "normal_clearing" }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, matched: 0 });
  });

  it("ignores an event with no call to attach to", async () => {
    const res = await post(event("call.initiated", {}));
    expect(await json(res)).toMatchObject({ ok: true, ignored: "call.initiated" });
  });
});
