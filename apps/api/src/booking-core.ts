import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { type AnyDb, booking } from "@tm/db";
import { type Config, idempotencyKey } from "@tm/shared";
import type { Slot } from "./availability/slots.js";
import type { Producer } from "./queue.js";

/**
 * A short, stable handle for a slot. The voice agent cannot be trusted to echo a UUID and an ISO
 * timestamp back correctly, so get_availability hands out these ids and book_job resolves one
 * against freshly computed slots — no server-side session state, and an id that has gone stale
 * simply stops matching.
 */
export const slotId = (s: Pick<Slot, "technician_id" | "window_start">) =>
  createHash("sha256").update(`${s.technician_id}:${s.window_start}`).digest("hex").slice(0, 10);

/** Approval fans out to the three fulfillment queues. Handlers are Phase 4/5 stubs; the envelope is fixed. */
export async function enqueueFulfillment(producer: Producer, bookingId: string): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all([
    producer.enqueue("hcp", "createJob", { entity_id: bookingId, idempotency_key: idempotencyKey("hcp", "createJob", bookingId), attempt: 0, enqueued_at: now }),
    producer.enqueue("graph", "createEvent", { entity_id: bookingId, idempotency_key: idempotencyKey("graph", "createEvent", bookingId), attempt: 0, enqueued_at: now }),
    producer.enqueue("resend", "sendPacket", { entity_id: bookingId, idempotency_key: idempotencyKey("resend", "sendPacket", bookingId), attempt: 0, enqueued_at: now }),
  ]);
}

export interface CreateBookingInput {
  contactId: string;
  technicianId: string;
  serviceAddressId: string;
  windowStart: Date;
  arrivalWindowMin: number;
  /** Set when the booking came from a live call, so the review queue can play the recording. */
  callId?: string;
}

/**
 * The single write path for a booking, shared by the public /book/:token page and the agent's
 * book_job tool. Idempotent on (contact, window_start): a retry or a repeated tool call returns
 * the existing row instead of double-booking. AUTO_BOOK is settled false, so the default is
 * pending_review and a human approves before anything reaches HCP.
 */
export async function createBooking(
  db: AnyDb, cfg: Config, producer: Producer, input: CreateBookingInput,
): Promise<{ booking: typeof booking.$inferSelect; created: boolean }> {
  const key = idempotencyKey("booking", input.contactId, input.windowStart.toISOString());
  const [row] = await db.insert(booking).values({
    contactId: input.contactId,
    technicianId: input.technicianId,
    serviceAddressId: input.serviceAddressId,
    windowStart: input.windowStart,
    arrivalWindowMin: input.arrivalWindowMin,
    status: cfg.AUTO_BOOK ? "approved" : "pending_review",
    idempotencyKey: key,
    ...(input.callId ? { callId: input.callId } : {}),
  }).onConflictDoNothing({ target: booking.idempotencyKey }).returning();

  const saved = row ?? (await db.select().from(booking).where(eq(booking.idempotencyKey, key)))[0]!;
  if (row && cfg.AUTO_BOOK) await enqueueFulfillment(producer, saved.id);
  return { booking: saved, created: !!row };
}
