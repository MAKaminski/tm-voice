import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { DISCLOSURE_LINE, SEED, call, callTask, seed, suppression, transcript } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import type { Ctx } from "../src/context.js";
import { dispositionFor, postcallProcess } from "../src/processors/postcall.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
let t: Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let taskId: string;
const enqueued: { job: string; payload: Record<string, unknown> }[] = [];
const env = (id: string) => ({ entity_id: id, idempotency_key: `postcall:${id}`, attempt: 0, enqueued_at: new Date().toISOString() });

beforeAll(async () => {
  t = await createTestDb();
  const r = await seed(t.db);
  ctx = {
    cfg, db: t.db, adapters: createAdapters(cfg),
    producer: createProducer(undefined, async (q, n, payload) => { enqueued.push({ job: `${q}.${n}`, payload }); }),
  };
  const dana = r.contacts.find((x) => x.phoneE164 === SEED.phones.landlineGa)!;
  const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, dana.id));
  taskId = task!.id;
  await t.db.update(callTask).set({ status: "dialed", attemptNo: 1 }).where(eq(callTask.id, taskId));
});
afterAll(() => t.close());

describe("dispositionFor", () => {
  const base = { endedReason: "customer-ended-call", booked: false, optedOut: false, customerTurns: 3 };
  it("lets facts we wrote beat Vapi's reason", () => {
    expect(dispositionFor({ ...base, optedOut: true, booked: true })).toBe("opt_out");
    expect(dispositionFor({ ...base, booked: true, endedReason: "voicemail" })).toBe("booked");
  });
  it("maps Vapi ended reasons", () => {
    expect(dispositionFor({ ...base, endedReason: "voicemail" })).toBe("voicemail");
    expect(dispositionFor({ ...base, endedReason: "customer-busy" })).toBe("busy");
    expect(dispositionFor({ ...base, endedReason: "customer-did-not-answer" })).toBe("no_answer");
    expect(dispositionFor({ ...base, endedReason: "pipeline-error-eleven-labs-blocked-free-plan-and-requested-upgrade" })).toBe("failed");
  });
  it("uses the structured outcome, else the number of customer turns", () => {
    expect(dispositionFor({ ...base, endedReason: "silence-timed-out", structuredOutcome: "voicemail" })).toBe("voicemail");
    expect(dispositionFor({ ...base, structuredOutcome: "not_interested" })).toBe("not_interested");
    expect(dispositionFor({ ...base, customerTurns: 0, endedReason: "silence-timed-out" })).toBe("no_answer");
    expect(dispositionFor({ ...base })).toBe("callback");
  });
});

describe("postcall.process", () => {
  it("records voicemail and the transcript, checks the disclosure, and re-queues the task in 48 h", async () => {
    await t.db.insert(call).values({ callTaskId: taskId, vapiCallId: "vapi_vm_1", startedAt: new Date("2026-09-13T21:50:56Z") });
    const out = await postcallProcess(ctx, {
      ...env("vapi_vm_1"), vapi_call_id: "vapi_vm_1", ended_reason: "voicemail",
      started_at: "2026-09-13T21:50:56Z", ended_at: "2026-09-13T21:51:20Z", cost_usd: 0.03,
      turns: [{ role: "assistant", text: DISCLOSURE_LINE, at_sec: 1.8 }, { role: "customer", text: "Please leave a message.", at_sec: 9 }],
    });
    expect(out).toMatchObject({ disposition: "voicemail", disclosure_ok: true });
    const [c] = await t.db.select().from(call).where(eq(call.vapiCallId, "vapi_vm_1"));
    expect(c).toMatchObject({ disposition: "voicemail", durationSec: 24, costUsd: "0.0300" });
    const [tr] = await t.db.select().from(transcript).where(eq(transcript.callId, c!.id));
    expect(tr?.turns).toHaveLength(2);
    const [task] = await t.db.select().from(callTask).where(eq(callTask.id, taskId));
    expect(task?.status).toBe("queued");
    expect(task?.earliestDialAt.toISOString()).toBe("2026-09-15T21:51:20.000Z");
  });

  it("is idempotent: a replayed report changes nothing", async () => {
    const out = await postcallProcess(ctx, { ...env("vapi_vm_1"), vapi_call_id: "vapi_vm_1", ended_reason: "customer-ended-call", turns: [] });
    expect(out).toMatchObject({ skipped: "already_processed", disposition: "voicemail" });
  });

  it("a vendor failure does not use up one of the contact's attempts", async () => {
    await t.db.update(callTask).set({ status: "dialed", attemptNo: 2 }).where(eq(callTask.id, taskId));
    await t.db.insert(call).values({ callTaskId: taskId, vapiCallId: "vapi_fail_1" });
    await postcallProcess(ctx, { ...env("vapi_fail_1"), vapi_call_id: "vapi_fail_1", ended_reason: "pipeline-error-eleven-labs-blocked-free-plan-and-requested-upgrade", turns: [] });
    const [task] = await t.db.select().from(callTask).where(eq(callTask.id, taskId));
    expect(task).toMatchObject({ status: "queued", attemptNo: 1 });
  });

  it("flags an opening that is not the disclosure line, and closes the task on not_interested", async () => {
    await t.db.update(callTask).set({ status: "dialed" }).where(eq(callTask.id, taskId));
    await t.db.insert(call).values({ callTaskId: taskId, vapiCallId: "vapi_ni_1" });
    const out = await postcallProcess(ctx, {
      ...env("vapi_ni_1"), vapi_call_id: "vapi_ni_1", ended_reason: "customer-ended-call", structured: { outcome: "not_interested" },
      turns: [{ role: "assistant", text: "Hey there, quick question for you.", at_sec: 1 }, { role: "customer", text: "No thanks.", at_sec: 4 }],
    });
    expect(out).toMatchObject({ disposition: "not_interested", disclosure_ok: false });
    const [task] = await t.db.select().from(callTask).where(eq(callTask.id, taskId));
    expect(task?.status).toBe("done");
  });

  it("vendor intake: PACKET_CAPTURED closes the task, keeps the captured fields, and needs a human callback", async () => {
    await t.db.update(callTask).set({ status: "dialed" }).where(eq(callTask.id, taskId));
    await t.db.insert(call).values({ callTaskId: taskId, vapiCallId: "vapi_pk_1" });
    const structured = { outcome: "PACKET_CAPTURED", packet_type: "PORTAL", packet_platform: "AppFolio", contact_email: "vendors@example.com" };
    const out = await postcallProcess(ctx, { ...env("vapi_pk_1"), vapi_call_id: "vapi_pk_1", ended_reason: "assistant-ended-call", structured, turns: [{ role: "customer", text: "Use our AppFolio portal.", at_sec: 5 }] });
    expect(out).toMatchObject({ disposition: "callback" });
    const [c] = await t.db.select().from(call).where(eq(call.vapiCallId, "vapi_pk_1"));
    const [tr] = await t.db.select().from(transcript).where(eq(transcript.callId, c!.id));
    expect(tr?.structured).toEqual(structured);
    const [task] = await t.db.select().from(callTask).where(eq(callTask.id, taskId));
    expect(task?.status).toBe("done");
  });

  it("an OPT_OUT heard on the call writes the suppression even without the tool call", async () => {
    await t.db.update(callTask).set({ status: "dialed" }).where(eq(callTask.id, taskId));
    await t.db.insert(call).values({ callTaskId: taskId, vapiCallId: "vapi_oo_1" });
    const out = await postcallProcess(ctx, { ...env("vapi_oo_1"), vapi_call_id: "vapi_oo_1", ended_reason: "customer-ended-call", structured: { outcome: "OPT_OUT" }, turns: [{ role: "customer", text: "Take me off your list.", at_sec: 3 }] });
    expect(out).toMatchObject({ disposition: "opt_out" });
    const rows = await t.db.select().from(suppression).where(eq(suppression.phoneE164, SEED.phones.landlineGa));
    expect(rows).toHaveLength(1);
  });

  it("ignores a report for a call we never placed", async () => {
    expect(await postcallProcess(ctx, { ...env("nope"), vapi_call_id: "nope", ended_reason: "voicemail", turns: [] })).toEqual({ skipped: "unknown_call" });
  });
});

describe("handing the recording off", () => {
  it("queues one postcall.recording job when the report carried a url", async () => {
    await t.db.insert(call).values({ callTaskId: taskId, vapiCallId: "vapi_rec_handoff" });
    const before = enqueued.length;
    await postcallProcess(ctx, {
      ...env("vapi_rec_handoff"), vapi_call_id: "vapi_rec_handoff", ended_reason: "customer-ended-call",
      recording_url: "https://storage.vapi.ai/x.wav", turns: [],
    });
    const jobs = enqueued.slice(before).filter((e) => e.job === "postcall.recording");
    // Separate job, not an inline step: a transient R2 or Vapi failure must not re-run the
    // disposition logic, and the url is short-lived so this is the step that needs retries.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      vapi_call_id: "vapi_rec_handoff",
      recording_url: "https://storage.vapi.ai/x.wav",
      idempotency_key: "postcall:recording:vapi_rec_handoff",
    });
  });

  it("queues nothing when there was no recording, and still writes the disposition", async () => {
    await t.db.insert(call).values({ callTaskId: taskId, vapiCallId: "vapi_no_rec" });
    const before = enqueued.length;
    const out = await postcallProcess(ctx, {
      ...env("vapi_no_rec"), vapi_call_id: "vapi_no_rec", ended_reason: "customer-ended-call", turns: [],
    }) as { disposition?: string };
    expect(enqueued.slice(before).filter((e) => e.job === "postcall.recording")).toHaveLength(0);
    // A missing recording is logged, never fatal — the disposition is the part that matters.
    expect(out.disposition).toBeDefined();
  });
});
