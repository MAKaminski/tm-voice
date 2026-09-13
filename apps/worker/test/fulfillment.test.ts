import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { SEED, booking, calendarInvite, contact, emailSend, seed, serviceAddress, technician } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import type { Ctx } from "../src/context.js";
import { graphCreateEvent, hcpCreateJob, packetHtml, resendSendPacket, loadBooking, windowEnd } from "../src/processors/fulfillment.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
let ctx: Ctx;
let bookingId: string;
let techId: string;
let contactId: string;

const env = (id: string) => ({ entity_id: id, idempotency_key: `k:${id}`, attempt: 0, enqueued_at: new Date().toISOString() });

beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db, { day: new Date(Date.now() + 86_400_000) });
  ctx = { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async () => {}) };

  contactId = r.contacts.find((c) => c.phoneE164 === SEED.phones.landlineGa)!.id;
  // Order explicitly: an unordered limit(1) can return a different row than the booking points at.
  const [tech] = await t.db.select().from(technician).orderBy(technician.name).limit(1);
  const [addr] = await t.db.select().from(serviceAddress).orderBy(serviceAddress.line1).limit(1);
  techId = tech!.id;

  const [b] = await t.db.insert(booking).values({
    contactId, technicianId: techId, serviceAddressId: addr!.id,
    windowStart: new Date("2026-09-20T14:00:00Z"), arrivalWindowMin: 120,
    status: "approved", idempotencyKey: "booking:test:1",
  }).returning();
  bookingId = b!.id;
});
afterAll(() => t.close());

/**
 * Restore every field these tests mutate. Doing it here rather than after each assertion means a
 * failing test cannot leak its fixture changes into the next one.
 */
beforeEach(async () => {
  await t.db.update(booking).set({ status: "approved", hcpJobId: null }).where(eq(booking.id, bookingId));
  await t.db.update(technician).set({ email: "pedro@tm.co", hcpEmployeeId: "emp_pedro" }).where(eq(technician.id, techId));
  await t.db.update(contact).set({ email: "dana@pm.co" }).where(eq(contact.id, contactId));
  await t.db.delete(calendarInvite).where(eq(calendarInvite.bookingId, bookingId));
  await t.db.delete(emailSend).where(eq(emailSend.bookingId, bookingId));
});

describe("loadBooking", () => {
  it("joins everything a handler needs in one query", async () => {
    const b = await loadBooking(t.db, bookingId);
    expect(b?.contact.email).toBe("dana@pm.co");
    expect(b?.technician.email).toBe("pedro@tm.co");
    expect(b?.address.line1).toBeTruthy();
    expect(b?.account.name).toBeTruthy();
  });
  it("returns null for an unknown booking", async () => {
    expect(await loadBooking(t.db, "3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a")).toBeNull();
  });
  it("derives the window end from the arrival window", async () => {
    const b = await loadBooking(t.db, bookingId);
    expect(windowEnd(b!.booking).toISOString()).toBe("2026-09-20T16:00:00.000Z");
  });
});

describe("hcp.createJob", () => {
  it("creates the job, stores the id and marks the booking synced", async () => {
    const res = await hcpCreateJob(ctx, env(bookingId)) as { hcp_job_id: string };
    expect(res.hcp_job_id).toBeTruthy();
    const [row] = await t.db.select().from(booking).where(eq(booking.id, bookingId));
    expect(row?.hcpJobId).toBe(res.hcp_job_id);
    expect(row?.status).toBe("synced");
    const sent = ctx.adapters.hcp.mock!.calls.filter((c) => c.method === "createJob").at(-1)!;
    // The booking id is the idempotency handle the adapter tags the HCP job with.
    expect((sent.args[0] as { idempotency_key: string }).idempotency_key).toBe(bookingId);
    expect((sent.args[0] as { employee_ids: string[] }).employee_ids).toEqual(["emp_pedro"]);
  });

  it("is a no-op once the booking already carries an HCP job id", async () => {
    await hcpCreateJob(ctx, env(bookingId));
    const before = ctx.adapters.hcp.mock!.calls.filter((c) => c.method === "createJob").length;
    const res = await hcpCreateJob(ctx, env(bookingId)) as { already_synced?: boolean };
    expect(res.already_synced).toBe(true);
    expect(ctx.adapters.hcp.mock!.calls.filter((c) => c.method === "createJob").length).toBe(before);
  });

  it("refuses to push a booking a human has not approved", async () => {
    await t.db.update(booking).set({ status: "pending_review" }).where(eq(booking.id, bookingId));
    expect(await hcpCreateJob(ctx, env(bookingId))).toEqual({ skipped: "not_approved" });
    await t.db.update(booking).set({ status: "rejected" }).where(eq(booking.id, bookingId));
    expect(await hcpCreateJob(ctx, env(bookingId))).toEqual({ skipped: "not_approved" });
  });

  it("skips a booking that no longer exists instead of failing forever", async () => {
    expect(await hcpCreateJob(ctx, env("3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a"))).toEqual({ skipped: "booking_not_found" });
  });
});

describe("graph.createEvent", () => {
  it("invites the technician and the customer and records the event id", async () => {
    const res = await graphCreateEvent(ctx, env(bookingId)) as { graph_event_id: string };
    expect(res.graph_event_id).toBeTruthy();
    const [inv] = await t.db.select().from(calendarInvite).where(eq(calendarInvite.bookingId, bookingId));
    expect(inv?.graphEventId).toBe(res.graph_event_id);
    const sent = ctx.adapters.graph.mock!.calls.filter((c) => c.method === "createEvent").at(-1)!;
    const arg = sent.args[0] as { attendees: { email: string }[]; transaction_id: string; end: string };
    expect(arg.attendees.map((a) => a.email)).toEqual(["pedro@tm.co", "dana@pm.co"]);
    expect(arg.transaction_id).toBe(`booking:${bookingId}`);
    expect(arg.end).toBe("2026-09-20T16:00:00.000Z");
  });

  it("does not create a second event for the same booking", async () => {
    await graphCreateEvent(ctx, env(bookingId));
    const before = ctx.adapters.graph.mock!.calls.filter((c) => c.method === "createEvent").length;
    const res = await graphCreateEvent(ctx, env(bookingId)) as { already_created?: boolean };
    expect(res.already_created).toBe(true);
    expect(ctx.adapters.graph.mock!.calls.filter((c) => c.method === "createEvent").length).toBe(before);
  });

  it("records the gap when there is nobody to invite", async () => {
    await t.db.update(technician).set({ email: null }).where(eq(technician.id, techId));
    await t.db.update(contact).set({ email: null }).where(eq(contact.id, contactId));

    expect(await graphCreateEvent(ctx, env(bookingId))).toEqual({ skipped: "no_attendee" });
    const [inv] = await t.db.select().from(calendarInvite).where(eq(calendarInvite.bookingId, bookingId));
    expect(inv?.rsvpStatus).toBe("no_attendee");
    expect(inv?.graphEventId).toBeNull();
  });
});

describe("resend.sendPacket", () => {
  it("writes the EMAIL_SEND row, sends, and stores the provider id", async () => {
    const res = await resendSendPacket(ctx, env(bookingId)) as { provider_message_id: string };
    const [row] = await t.db.select().from(emailSend).where(eq(emailSend.bookingId, bookingId));
    expect(row?.status).toBe("sent");
    expect(row?.providerMessageId).toBe(res.provider_message_id);
    expect(row?.template).toBe("booking_confirmation");
    const sent = ctx.adapters.resend.mock!.calls.filter((c) => c.method === "sendEmail").at(-1)!;
    const arg = sent.args[0] as { to: string; idempotency_key: string; html: string };
    expect(arg.to).toBe("dana@pm.co");
    expect(arg.idempotency_key).toBe(`email:booking_confirmation:${bookingId}`);
    expect(arg.html).toContain("Transparent Maintenance");
  });

  it("does not send twice for one booking", async () => {
    await resendSendPacket(ctx, env(bookingId));
    const before = ctx.adapters.resend.mock!.calls.filter((c) => c.method === "sendEmail").length;
    const res = await resendSendPacket(ctx, env(bookingId)) as { already_sent?: boolean };
    expect(res.already_sent).toBe(true);
    expect(ctx.adapters.resend.mock!.calls.filter((c) => c.method === "sendEmail").length).toBe(before);
    expect(await t.db.select().from(emailSend).where(eq(emailSend.bookingId, bookingId))).toHaveLength(1);
  });

  it("marks the row failed and rethrows so the job retries", async () => {
    const failing = {
      ...ctx.adapters,
      resend: { ...ctx.adapters.resend, async sendEmail() { throw new Error("resend down"); } },
    } as typeof ctx.adapters;
    await expect(resendSendPacket({ ...ctx, adapters: failing }, env(bookingId))).rejects.toThrow(/resend down/);
    const [row] = await t.db.select().from(emailSend).where(eq(emailSend.bookingId, bookingId));
    expect(row?.status).toBe("failed");
  });

  it("skips a contact with no email rather than failing forever", async () => {
    await t.db.update(contact).set({ email: null }).where(eq(contact.id, contactId));
    expect(await resendSendPacket(ctx, env(bookingId))).toEqual({ skipped: "no_email" });
  });

  it("renders the window and address the customer will read", async () => {
    const b = await loadBooking(t.db, bookingId);
    const html = packetHtml(b!);
    expect(html).toContain("10:00 AM");
    expect(html).toContain(b!.address.line1);
    expect(html).toContain(b!.technician.name);
  });
});
