import { eq } from "drizzle-orm";
import { type AnyDb, account, booking, calendarInvite, contact, emailSend, serviceAddress, technician } from "@tm/db";
import { logger } from "@tm/shared";
import type { Processor } from "../context.js";

/** Everything the three fulfillment handlers need about one booking, loaded once. */
export interface BookingBundle {
  booking: typeof booking.$inferSelect;
  contact: typeof contact.$inferSelect;
  technician: typeof technician.$inferSelect;
  address: typeof serviceAddress.$inferSelect;
  account: typeof account.$inferSelect;
}

export async function loadBooking(db: AnyDb, bookingId: string): Promise<BookingBundle | null> {
  const [row] = await db.select({ booking, contact, technician, address: serviceAddress, account })
    .from(booking)
    .innerJoin(contact, eq(contact.id, booking.contactId))
    .innerJoin(technician, eq(technician.id, booking.technicianId))
    .innerJoin(serviceAddress, eq(serviceAddress.id, booking.serviceAddressId))
    .innerJoin(account, eq(account.id, contact.accountId))
    .where(eq(booking.id, bookingId));
  return row ?? null;
}

/**
 * Fulfillment only ever runs for a booking a human approved (or AUTO_BOOK, which is settled false).
 * A pending_review or rejected booking reaching a handler is a bug upstream, not something to
 * push through — the guard returns rather than throwing so the job does not retry forever.
 */
function approvedOnly(b: typeof booking.$inferSelect, queue: string): boolean {
  if (b.status === "approved" || b.status === "synced") return true;
  logger.warn({ booking_id: b.id, status: b.status, queue }, "fulfillment skipped: booking is not approved");
  return false;
}

const fmt = (iso: Date, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(iso);

const addressLine = (a: typeof serviceAddress.$inferSelect) =>
  [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.zip].filter(Boolean).join(" · ");

export const windowEnd = (b: typeof booking.$inferSelect) =>
  new Date(b.windowStart.getTime() + b.arrivalWindowMin * 60_000);

/**
 * Pushes the approved booking into Housecall Pro, which is the field system of record. The HCP job
 * id is stored on the booking and its presence is what makes this idempotent: a retry after a
 * partial failure re-uses invoice_number so HCP returns the same job rather than creating a second.
 */
export const hcpCreateJob: Processor = async (ctx, payload) => {
  const b = await loadBooking(ctx.db, payload.entity_id);
  if (!b) return { skipped: "booking_not_found" };
  if (!approvedOnly(b.booking, "hcp")) return { skipped: "not_approved" };
  if (b.booking.hcpJobId) return { hcp_job_id: b.booking.hcpJobId, already_synced: true };

  const res = await ctx.adapters.hcp.createJob({
    ...(b.account.hcpCustomerId ? { customer_id: b.account.hcpCustomerId } : {}),
    ...(b.address.hcpAddressId ? { address_id: b.address.hcpAddressId } : {}),
    description: `Booked by voice agent for ${[b.contact.firstName, b.contact.lastName].filter(Boolean).join(" ") || b.contact.phoneE164}`,
    scheduled_start: b.booking.windowStart.toISOString(),
    arrival_window_in_minutes: b.booking.arrivalWindowMin,
    employee_ids: b.technician.hcpEmployeeId ? [b.technician.hcpEmployeeId] : [],
    // HCP has no idempotency header and assigns invoice numbers itself; the adapter carries this
    // as a tm-voice:<id> tag and finds the job by it on retry.
    idempotency_key: b.booking.id,
  });

  await ctx.db.update(booking).set({ hcpJobId: res.id, status: "synced", updatedAt: new Date() }).where(eq(booking.id, b.booking.id));
  logger.info({ booking_id: b.booking.id, hcp_job_id: res.id }, "booking synced to HCP");
  return { hcp_job_id: res.id };
};

/**
 * Puts the appointment on the shared booking mailbox's calendar and invites whoever we can reach.
 * The technician is the attendee whose RSVP matters; the customer is invited when we hold an email.
 */
export const graphCreateEvent: Processor = async (ctx, payload) => {
  const b = await loadBooking(ctx.db, payload.entity_id);
  if (!b) return { skipped: "booking_not_found" };
  if (!approvedOnly(b.booking, "graph")) return { skipped: "not_approved" };

  const [existing] = await ctx.db.select().from(calendarInvite).where(eq(calendarInvite.bookingId, b.booking.id));
  if (existing?.graphEventId) return { graph_event_id: existing.graphEventId, already_created: true };

  const attendees = [
    ...(b.technician.email ? [{ email: b.technician.email, name: b.technician.name }] : []),
    ...(b.contact.email ? [{ email: b.contact.email }] : []),
  ];
  if (!attendees.length) {
    // Nobody to invite: record the gap instead of retrying a call that cannot succeed.
    await ctx.db.insert(calendarInvite).values({ bookingId: b.booking.id, rsvpStatus: "no_attendee" }).onConflictDoNothing();
    logger.warn({ booking_id: b.booking.id, technician_id: b.technician.id }, "calendar invite skipped: no technician or contact email on file");
    return { skipped: "no_attendee" };
  }

  const name = [b.contact.firstName, b.contact.lastName].filter(Boolean).join(" ") || b.contact.phoneE164;
  const res = await ctx.adapters.graph.createEvent({
    subject: `Service visit — ${name}`,
    body_html: `<p>Arrival window ${fmt(b.booking.windowStart, b.contact.timezone)} – ${fmt(windowEnd(b.booking), b.contact.timezone)}.</p>`
      + `<p>${addressLine(b.address)}</p><p>Contact: ${b.contact.phoneE164}</p>`,
    start: b.booking.windowStart.toISOString(),
    end: windowEnd(b.booking).toISOString(),
    timezone: b.contact.timezone,
    location: addressLine(b.address),
    attendees,
    // Graph rejects a repeated transactionId, so a retry cannot double-book the calendar.
    transaction_id: `booking:${b.booking.id}`,
  });

  if (existing) {
    await ctx.db.update(calendarInvite).set({ graphEventId: res.id, updatedAt: new Date() }).where(eq(calendarInvite.id, existing.id));
  } else {
    await ctx.db.insert(calendarInvite).values({ bookingId: b.booking.id, graphEventId: res.id });
  }
  logger.info({ booking_id: b.booking.id, graph_event_id: res.id }, "calendar invite created");
  return { graph_event_id: res.id };
};

export const PACKET_TEMPLATE = "booking_confirmation";

export function packetHtml(b: BookingBundle): string {
  const name = b.contact.firstName ?? "there";
  return [
    `<p>Hi ${name},</p>`,
    `<p>Your service visit is set for <strong>${fmt(b.booking.windowStart, b.contact.timezone)}</strong>.`,
    ` The technician will arrive within a ${b.booking.arrivalWindowMin}-minute window ending ${fmt(windowEnd(b.booking), b.contact.timezone)}.</p>`,
    `<p><strong>Address</strong><br>${addressLine(b.address)}</p>`,
    `<p><strong>Technician</strong><br>${b.technician.name}</p>`,
    `<p>Reply to this email if anything needs to change.</p>`,
    `<p>— Transparent Maintenance</p>`,
  ].join("");
}

/**
 * Emails the customer their confirmation. The EMAIL_SEND row is written before the send and keyed
 * on the booking, so the unique index — not the vendor — is what stops a duplicate email, and a
 * failed send leaves a row saying so rather than disappearing.
 */
export const resendSendPacket: Processor = async (ctx, payload) => {
  const b = await loadBooking(ctx.db, payload.entity_id);
  if (!b) return { skipped: "booking_not_found" };
  if (!approvedOnly(b.booking, "resend")) return { skipped: "not_approved" };
  if (!b.contact.email) {
    logger.warn({ booking_id: b.booking.id }, "packet not sent: no email on the contact");
    return { skipped: "no_email" };
  }

  const key = `email:${PACKET_TEMPLATE}:${b.booking.id}`;
  const [row] = await ctx.db.insert(emailSend)
    .values({ bookingId: b.booking.id, template: PACKET_TEMPLATE, idempotencyKey: key, status: "queued" })
    .onConflictDoNothing({ target: emailSend.idempotencyKey })
    .returning();
  const send = row ?? (await ctx.db.select().from(emailSend).where(eq(emailSend.idempotencyKey, key)))[0]!;
  if (send.status === "sent") return { email_send_id: send.id, provider_message_id: send.providerMessageId, already_sent: true };

  try {
    const res = await ctx.adapters.resend.sendEmail({
      to: b.contact.email,
      subject: `Your service visit — ${fmt(b.booking.windowStart, b.contact.timezone)}`,
      html: packetHtml(b),
      template: PACKET_TEMPLATE,
      idempotency_key: key,
    });
    await ctx.db.update(emailSend).set({ providerMessageId: res.id, status: "sent", updatedAt: new Date() }).where(eq(emailSend.id, send.id));
    logger.info({ booking_id: b.booking.id, email_send_id: send.id, provider_message_id: res.id }, "packet sent");
    return { email_send_id: send.id, provider_message_id: res.id };
  } catch (e) {
    // Leave a durable record of the failure; BullMQ still retries the job.
    await ctx.db.update(emailSend).set({ status: "failed", updatedAt: new Date() }).where(eq(emailSend.id, send.id));
    throw e;
  }
};
