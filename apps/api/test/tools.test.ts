import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { SEED, booking, call, callTask, contact, seed, serviceAddress, technician } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { createApp } from "../src/app.js";
import { createProducer } from "../src/queue.js";
import { describeSlot, callTaskIdFrom } from "../src/routes/tools.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123", NODE_ENV: "test" });
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
let app: ReturnType<typeof createApp>;
let taskId: string;
let vapiCallId: string;
const enqueued: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db, { day: new Date(Date.now() + 86_400_000) });
  app = createApp({ cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async (q, n) => { enqueued.push(`${q}.${n}`); }) });
  const dana = r.contacts.find((c) => c.phoneE164 === SEED.phones.landlineGa)!;
  const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, dana.id));
  taskId = task!.id;
  vapiCallId = "vapi_call_abc";
  const [row] = await t.db.insert(call).values({ callTaskId: taskId, didId: r.did.id, vapiCallId }).returning();
  expect(row).toBeDefined();
});
afterAll(() => t.close());

/** Vapi signs the raw body with the assistant's server secret. */
function post(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", "mock-vapi-secret").update(raw).digest("hex");
  return app.request(path, { method: "POST", body: raw, headers: { "x-vapi-signature": sig } });
}
const msg = (tool: string, args: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  message: {
    type: "tool-calls",
    call: { id: vapiCallId, name: taskId, customer: { number: SEED.phones.landlineGa }, ...over },
    toolCalls: [{ id: `tc_${tool}`, function: { name: tool, arguments: args } }],
  },
});

describe("correlation", () => {
  it("reads call_task_id from `name`, since Vapi has no metadata field", () => {
    expect(callTaskIdFrom({ type: "tool-calls", call: { id: "c", name: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a" }, toolCalls: [] } as never))
      .toBe("3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a");
  });
  it("prefers a real metadata field if Vapi ever provides one, and ignores a non-uuid name", () => {
    expect(callTaskIdFrom({ type: "tool-calls", call: { id: "c", name: "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a", metadata: { call_task_id: "aaaaaaaa-1111-2222-3333-444444444444" } }, toolCalls: [] } as never))
      .toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(callTaskIdFrom({ type: "tool-calls", call: { id: "c", name: "Outbound call" }, toolCalls: [] } as never)).toBeUndefined();
  });
  it("renders windows in the contact's timezone", () => {
    const d = describeSlot("2026-09-15T12:00:00.000Z", "2026-09-15T14:00:00.000Z", "America/New_York");
    expect(d.day).toMatch(/Sep 15/);
    expect(d.window).toBe("8:00 AM to 10:00 AM");
  });
});

describe("POST /tools/get_availability", () => {
  it("rejects an unsigned request", async () => {
    const res = await app.request("/tools/get_availability", { method: "POST", body: "{}", headers: { "x-vapi-secret": "wrong" } });
    expect(res.status).toBe(401);
  });

  it("returns speakable options with opaque slot ids", async () => {
    const res = await post("/tools/get_availability", msg("get_availability"));
    expect(res.status).toBe(200);
    const result = (await json(res)).results[0].result;
    expect(result.available).toBe(true);
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options.length).toBeLessThanOrEqual(3);
    for (const o of result.options) {
      expect(o.slot_id).toMatch(/^[0-9a-f]{10}$/);
      expect(o.window).toMatch(/AM|PM/);
    }
    expect(result.say).toMatch(/Which works best/);
    expect(result.instruction).toMatch(/Never read a slot_id aloud/);
  });

  it("answers gracefully when the contact is unknown", async () => {
    // A distinct call id, or the idempotency cache would replay the successful answer above.
    const res = await post("/tools/get_availability", msg("get_availability", {}, { id: "vapi_call_unknown", name: "not-a-uuid", customer: { number: "+19995550000" } }));
    const result = (await json(res)).results[0].result;
    expect(result.available).toBe(false);
    expect(result.say).toMatch(/follow up/);
  });
});

describe("POST /tools/book_job", () => {
  let slot: { slot_id: string; day: string; window: string };

  it("books the chosen slot as pending_review and links it to the call", async () => {
    const avail = (await json(await post("/tools/get_availability", msg("get_availability")))).results[0].result;
    slot = avail.options[0];

    const res = await post("/tools/book_job", msg("book_job", { slot_id: slot.slot_id }));
    expect(res.status).toBe(200);
    const result = (await json(res)).results[0].result;
    expect(result.booked).toBe(true);
    // AUTO_BOOK is false, so the agent must not promise a confirmed appointment.
    expect(result.status).toBe("pending_review");
    expect(result.say).toMatch(/once our office checks/);

    const [row] = await t.db.select().from(booking).where(eq(booking.id, result.booking_id));
    expect(row?.status).toBe("pending_review");
    const [c] = await t.db.select().from(call).where(eq(call.vapiCallId, vapiCallId));
    expect(row?.callId).toBe(c!.id);
    // pending_review must not fan out to fulfillment yet.
    expect(enqueued).not.toContain("hcp.createJob");
  });

  it("a repeated tool call returns the first answer instead of booking twice", async () => {
    const before = await t.db.select().from(booking);
    const res = await post("/tools/book_job", msg("book_job", { slot_id: slot.slot_id }));
    const result = (await json(res)).results[0].result;
    expect(result.booked).toBe(true);
    expect(await t.db.select().from(booking)).toHaveLength(before.length);
  });

  it("offers alternatives when the slot id no longer matches", async () => {
    const res = await post("/tools/book_job", msg("book_job", { slot_id: "deadbeef00" }));
    const result = (await json(res)).results[0].result;
    expect(result.booked).toBe(false);
    expect(result.reason).toBe("slot_unavailable");
    expect(result.say).toMatch(/just taken/);
  });

  it("asks again when the agent omits the slot id", async () => {
    const res = await post("/tools/book_job", msg("book_job", {}));
    const result = (await json(res)).results[0].result;
    expect(result.booked).toBe(false);
    expect(result.say).toMatch(/Which of those windows/);
  });
});

describe("POST /tools/opt_out", () => {
  it("suppresses the number and tells the agent to end the call", async () => {
    const res = await post("/tools/opt_out", msg("opt_out", { reason: "said stop" }, { customer: { number: SEED.phones.landlineFl } }));
    expect(res.status).toBe(200);
    expect((await json(res)).results[0].result).toMatch(/end the call/);
  });

  it("hands the agent a recoverable line when arguments are unusable", async () => {
    const res = await post("/tools/opt_out", msg("opt_out", { phone_e164: "nope" }, { customer: { number: "bad" } }));
    expect(res.status).toBe(200);
    expect((await json(res)).results[0].error).toMatch(/call them back/);
  });
});

describe("POST /tools/send_packet", () => {
  it("tells the caller their details are still being confirmed when nothing is approved", async () => {
    await t.db.update(contact).set({ email: "dana@pm.co" }).where(eq(contact.phoneE164, SEED.phones.landlineGa));
    const res = await post("/tools/send_packet", msg("send_packet", {}, { id: "vapi_sp_1" }));
    const result = (await json(res)).results[0].result;
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("no_approved_booking");
    expect(result.say).toMatch(/still being confirmed/);
  });

  it("queues the packet once a booking is approved", async () => {
    const [c] = await t.db.select().from(contact).where(eq(contact.phoneE164, SEED.phones.landlineGa));
    const [tech] = await t.db.select().from(technician).orderBy(technician.name).limit(1);
    const [addr] = await t.db.select().from(serviceAddress).orderBy(serviceAddress.line1).limit(1);
    await t.db.insert(booking).values({
      contactId: c!.id, technicianId: tech!.id, serviceAddressId: addr!.id,
      windowStart: new Date("2026-09-22T14:00:00Z"), status: "approved", idempotencyKey: "booking:sp:1",
    });
    const res = await post("/tools/send_packet", msg("send_packet", {}, { id: "vapi_sp_2" }));
    const result = (await json(res)).results[0].result;
    expect(result.sent).toBe(true);
    expect(result.say).toContain("dana@pm.co");
    expect(enqueued).toContain("resend.sendPacket");
  });

  it("does not promise an email it cannot send", async () => {
    const [c] = await t.db.select().from(contact).where(eq(contact.phoneE164, SEED.phones.landlineGa));
    await t.db.update(contact).set({ email: null }).where(eq(contact.id, c!.id));
    const res = await post("/tools/send_packet", msg("send_packet", {}, { id: "vapi_sp_3" }));
    const result = (await json(res)).results[0].result;
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("no_email");
    expect(result.say).toMatch(/office follow up/);
  });
});

describe("POST /webhooks/vapi", () => {
  const report = {
    message: {
      type: "end-of-call-report", endedReason: "voicemail", cost: 0.09,
      startedAt: "2026-09-13T21:50:56Z", endedAt: "2026-09-13T21:52:24Z",
      call: { id: "vapi_call_eoc", name: "8286b444-5d54-4145-8746-e3413fa90548" },
      analysis: { summary: "Reached voicemail.", structuredData: { outcome: "voicemail" } },
      artifact: { messages: [{ role: "system", message: "prompt" }, { role: "bot", message: "Hi", secondsFromStart: 1.84 }, { role: "user", message: "Leave a message", secondsFromStart: 9 }] },
    },
  };
  it("rejects an unsigned report", async () => {
    const res = await app.request("/webhooks/vapi", { method: "POST", body: JSON.stringify(report) });
    expect(res.status).toBe(401);
  });
  it("queues one postcall.process job for an end-of-call report", async () => {
    const before = enqueued.length;
    const res = await post("/webhooks/vapi", report);
    expect(res.status).toBe(200);
    expect(enqueued.slice(before)).toEqual(["postcall.process"]);
  });
  it("acknowledges and drops other message types", async () => {
    const before = enqueued.length;
    const res = await post("/webhooks/vapi", { message: { type: "status-update", status: "in-progress" } });
    expect(await json(res)).toMatchObject({ ok: true, ignored: "status-update" });
    expect(enqueued.length).toBe(before);
  });
  it("reduces the report to turns without the system prompt", async () => {
    const { postcallPayloadFrom } = await import("../src/routes/webhooks.js");
    const p = postcallPayloadFrom(report.message as never);
    expect(p).toMatchObject({ vapi_call_id: "vapi_call_eoc", call_task_id: "8286b444-5d54-4145-8746-e3413fa90548", ended_reason: "voicemail", cost_usd: 0.09, structured: { outcome: "voicemail" } });
    expect(p.turns).toEqual([{ role: "assistant", text: "Hi", at_sec: 1.8 }, { role: "customer", text: "Leave a message", at_sec: 9 }]);
  });
});
