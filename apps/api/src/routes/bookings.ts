import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { booking, campaign, contact, serviceAddress, technician } from "@tm/db";
import { logger } from "@tm/shared";

import type { AppEnv } from "../app.js";
import { createBooking, enqueueFulfillment } from "../booking-core.js";
import { internalAuth } from "../middleware.js";

const bookBody = z.object({
  technician_id: z.string().uuid(),
  service_address_id: z.string().uuid(),
  window_start: z.string().datetime(),
  arrival_window_min: z.number().int().positive().default(120),
});

/**
 * Public, token-per-contact booking page API (/book/:token) and internal listing routes.
 * Booking status is pending_review unless AUTO_BOOK=true (settled: false — a human reviews every booking).
 */
export function bookingRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/book/:token", async (c) => {
    const { db } = c.get("deps");
    const [ct] = await db.select().from(contact).where(eq(contact.bookingToken, c.req.param("token")));
    if (!ct) return c.json({ error: "invalid_token" }, 404);
    const addresses = await db.select().from(serviceAddress).where(eq(serviceAddress.accountId, ct.accountId));
    const addr = addresses[0];
    const earliest = new Date();
    const slots = addr ? await c.get("availability").getSlots({ serviceAddressId: addr.id, earliest, latest: new Date(earliest.getTime() + 14 * 86_400_000) }) : [];
    return c.json({ contact: { first_name: ct.firstName, last_name: ct.lastName }, addresses, slots });
  });

  app.post("/book/:token", async (c) => {
    const { db, cfg, producer } = c.get("deps");
    const [ct] = await db.select().from(contact).where(eq(contact.bookingToken, c.req.param("token")));
    if (!ct) return c.json({ error: "invalid_token" }, 404);
    const p = bookBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid_body", issues: p.error.flatten() }, 400);

    const windowStart = new Date(p.data.window_start);
    const slots = await c.get("availability").getSlots({ serviceAddressId: p.data.service_address_id, earliest: new Date(windowStart.getTime() - 1), latest: new Date(windowStart.getTime() + 86_400_000), limit: 5 });
    const still = slots.find((s) => s.window_start === windowStart.toISOString() && s.technician_id === p.data.technician_id);
    if (!still) return c.json({ error: "slot_unavailable" }, 409);

    const { booking: saved, created } = await createBooking(db, cfg, producer, {
      contactId: ct.id, technicianId: p.data.technician_id, serviceAddressId: p.data.service_address_id,
      windowStart, arrivalWindowMin: p.data.arrival_window_min,
    });
    await c.get("availability").invalidate();
    return c.json({ booking: saved }, created ? 201 : 200);
  });

  app.get("/bookings", internalAuth, async (c) => {
    const { db } = c.get("deps");
    const status = c.req.query("status");
    const rows = await db.select({ booking, contact: { firstName: contact.firstName, lastName: contact.lastName, phone: contact.phoneE164 }, technician: { name: technician.name } })
      .from(booking).innerJoin(contact, eq(contact.id, booking.contactId)).innerJoin(technician, eq(technician.id, booking.technicianId))
      .where(status ? eq(booking.status, status as typeof booking.$inferSelect.status) : undefined).orderBy(desc(booking.createdAt)).limit(100);
    return c.json({ bookings: rows });
  });

  app.post("/bookings/:id/review", internalAuth, async (c) => {
    const { db, producer } = c.get("deps");
    const body = z.object({ decision: z.enum(["approve", "reject"]), reviewed_by: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const [row] = await db.update(booking).set({ status: body.data.decision === "approve" ? "approved" : "rejected", reviewedBy: body.data.reviewed_by, reviewedAt: new Date() })
      .where(and(eq(booking.id, c.req.param("id")), eq(booking.status, "pending_review"))).returning();
    if (!row) return c.json({ error: "not_pending" }, 409);
    if (row.status === "approved") await enqueueFulfillment(producer, row.id);
    return c.json({ booking: row });
  });

  app.get("/campaigns", internalAuth, async (c) => {
    const { db } = c.get("deps");
    return c.json({ campaigns: await db.select().from(campaign).orderBy(desc(campaign.createdAt)) });
  });

  /**
   * Stop dialling. Until this existed the only way to halt a campaign mid-flight was a Railway
   * environment change or a hand-edited database row — which is not something you want to be
   * working out while a bad list is being dialled.
   *
   * It is effective because the pre-dial gate now refuses to claim a task whose campaign is not
   * active: pausing here stops the next claim, including one from a replayed dial.claim job.
   * Calls already in flight are not hung up, which is deliberate — dropping a live call on a
   * prospect mid-sentence is worse than letting it finish.
   */
  app.patch("/campaigns/:id", internalAuth, async (c) => {
    const { db } = c.get("deps");
    const body = z.object({ status: z.enum(["draft", "active", "paused", "completed"]) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const [row] = await db.update(campaign).set({ status: body.data.status, updatedAt: new Date() })
      .where(eq(campaign.id, c.req.param("id"))).returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    logger.warn({ campaign_id: row.id, status: row.status }, "campaign status changed from the console");
    return c.json({ campaign: row });
  });
  return app;
}
