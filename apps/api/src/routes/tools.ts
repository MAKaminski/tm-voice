import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { suppress } from "@tm/compliance";
import { type AnyDb, call, callTask, contact, serviceAddress } from "@tm/db";
import { logger } from "@tm/shared";
import type { AppEnv } from "../app.js";
import { createBooking, slotId } from "../booking-core.js";
import { toolIdempotencyKey } from "../tool-idempotency.js";
import { vapiAuth } from "../middleware.js";

/** Vapi server-message envelope for tool calls (subset). */
const toolCallMessage = z.object({
  message: z.object({
    type: z.literal("tool-calls"),
    call: z.object({
      id: z.string(),
      /** Vapi has no metadata field on a call, so the vapi adapter puts call_task_id here. */
      name: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      customer: z.object({ number: z.string() }).optional(),
    }).optional(),
    toolCalls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.union([z.record(z.unknown()), z.string()]) }) })),
  }),
});
type ToolMessage = z.infer<typeof toolCallMessage>["message"];

const parseArgs = (a: unknown) => (typeof a === "string" ? (JSON.parse(a || "{}") as Record<string, unknown>) : (a as Record<string, unknown>));

/** The correlation id the dialer stamped on the call, preferring a real metadata field if one appears. */
export function callTaskIdFrom(msg: ToolMessage): string | undefined {
  const fromMetadata = msg.call?.metadata?.["call_task_id"];
  if (typeof fromMetadata === "string" && fromMetadata) return fromMetadata;
  const name = msg.call?.name;
  return name && /^[0-9a-f-]{36}$/i.test(name) ? name : undefined;
}

export interface CallContext {
  contact: typeof contact.$inferSelect;
  address: typeof serviceAddress.$inferSelect;
  callId?: string;
}

/**
 * Resolves which contact is on the phone. The call_task id the dialer stamped is authoritative;
 * the customer's number is the fallback so an inbound or manually placed call still works.
 */
export async function resolveCallContext(db: AnyDb, msg: ToolMessage): Promise<CallContext | { error: string }> {
  let ct: typeof contact.$inferSelect | undefined;
  const taskId = callTaskIdFrom(msg);
  if (taskId) {
    const [row] = await db.select({ c: contact }).from(callTask)
      .innerJoin(contact, eq(contact.id, callTask.contactId)).where(eq(callTask.id, taskId)).limit(1);
    ct = row?.c;
  }
  if (!ct && msg.call?.customer?.number) {
    const [row] = await db.select().from(contact).where(eq(contact.phoneE164, msg.call.customer.number)).limit(1);
    ct = row;
  }
  if (!ct) return { error: "unknown_contact" };

  const [address] = await db.select().from(serviceAddress).where(eq(serviceAddress.accountId, ct.accountId)).limit(1);
  if (!address) return { error: "no_service_address" };

  let callId: string | undefined;
  if (msg.call?.id) {
    const [c] = await db.select({ id: call.id }).from(call).where(eq(call.vapiCallId, msg.call.id)).orderBy(desc(call.startedAt)).limit(1);
    callId = c?.id;
  }
  return { contact: ct, address, callId };
}

/** Times the caller hears, in their own timezone rather than the server's. */
export function describeSlot(startIso: string, endIso: string, tz: string) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(startIso));
  const t = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return { day, window: `${t(startIso)} to ${t(endIso)}` };
}

const HORIZON_DAYS = 14;
const MAX_OPTIONS = 3;

/**
 * Agent tool endpoints called by Vapi. All verify the webhook secret and are idempotent on
 * call id + tool + arguments, so a retried webhook never books twice.
 */
export function toolRoutes() {
  const app = new Hono<AppEnv>().use(vapiAuth);

  /** send_packet still needs the resend fulfillment processor (Phase 4). */
  app.post("/send_packet", (c) => c.json({ error: "not_implemented", tool: "send_packet", phase: 4 }, 501));

  /** Shared shape: parse, verify, then run `handle` once per tool call with idempotency. */
  const toolHandler = (
    tool: string,
    handle: (c: Context<AppEnv>, msg: ToolMessage, args: Record<string, unknown>) => Promise<unknown>,
  ) => async (c: Context<AppEnv>) => {
    const raw = c.get("rawBody" as never) as string;
    const parsed = toolCallMessage.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.flatten() }, 400);
    const msg = parsed.data.message;
    const idem = c.get("toolIdem");
    const callId = msg.call?.id ?? "unknown";
    const results: { toolCallId: string; result?: unknown; error?: string }[] = [];

    for (const tc of msg.toolCalls) {
      const args = parseArgs(tc.function.arguments);
      const key = toolIdempotencyKey(callId, tool, args);
      const cached = await idem.get(key);
      if (cached !== undefined) { results.push({ toolCallId: tc.id, result: cached }); continue; }
      try {
        const result = await handle(c, msg, args);
        await idem.set(key, result);
        results.push({ toolCallId: tc.id, result });
      } catch (e) {
        // A tool failure must not kill the call: hand the agent something to say instead.
        logger.error({ e, tool, call_id: callId }, "tool call failed");
        results.push({ toolCallId: tc.id, error: "Tell the caller you are having trouble looking that up and offer to have someone call them back." });
      }
    }
    return c.json({ results });
  };

  app.post("/get_availability", toolHandler("get_availability", async (c, msg) => {
    const { db } = c.get("deps");
    const ctx = await resolveCallContext(db, msg);
    if ("error" in ctx) return { available: false, say: "I can't find your service address on file. Someone from our office will follow up." };

    const earliest = new Date();
    const slots = await c.get("availability").getSlots({
      serviceAddressId: ctx.address.id, earliest, latest: new Date(earliest.getTime() + HORIZON_DAYS * 86_400_000), limit: MAX_OPTIONS,
    });
    if (!slots.length) return { available: false, say: "I don't have any openings in the next two weeks. Someone from our office will call you to arrange a time." };

    const options = slots.map((s) => ({ slot_id: slotId(s), ...describeSlot(s.window_start, s.window_end, ctx.contact.timezone), technician: s.technician_name }));
    return {
      available: true,
      options,
      instruction: "Offer these windows to the caller. When they pick one, call book_job with that option's slot_id. Never read a slot_id aloud.",
      say: `I have ${options.length === 1 ? "one opening" : `${options.length} openings`}: ${options.map((o) => `${o.day}, ${o.window}`).join("; ")}. Which works best?`,
    };
  }));

  app.post("/book_job", toolHandler("book_job", async (c, msg, args) => {
    const { db, cfg, producer } = c.get("deps");
    const ctx = await resolveCallContext(db, msg);
    if ("error" in ctx) return { booked: false, say: "I can't find your account on file. Someone from our office will follow up." };

    const wanted = typeof args["slot_id"] === "string" ? args["slot_id"] : "";
    if (!wanted) return { booked: false, say: "Which of those windows would you like?" };

    // Recompute rather than trust the id: the slot may have been taken since get_availability.
    const earliest = new Date();
    const slots = await c.get("availability").getSlots({
      serviceAddressId: ctx.address.id, earliest, latest: new Date(earliest.getTime() + HORIZON_DAYS * 86_400_000), limit: 25,
    });
    const slot = slots.find((s) => slotId(s) === wanted);
    if (!slot) {
      const options = slots.slice(0, MAX_OPTIONS).map((s) => ({ slot_id: slotId(s), ...describeSlot(s.window_start, s.window_end, ctx.contact.timezone) }));
      return {
        booked: false, reason: "slot_unavailable", options,
        say: options.length ? `That window was just taken. I still have ${options.map((o) => `${o.day}, ${o.window}`).join("; ")}.` : "That window was just taken, and I have nothing else free. Our office will call you.",
      };
    }

    const { booking: saved } = await createBooking(db, cfg, producer, {
      contactId: ctx.contact.id, technicianId: slot.technician_id, serviceAddressId: ctx.address.id,
      windowStart: new Date(slot.window_start), arrivalWindowMin: slot.arrival_window_min,
      ...(ctx.callId ? { callId: ctx.callId } : {}),
    });
    await c.get("availability").invalidate();

    const when = describeSlot(slot.window_start, slot.window_end, ctx.contact.timezone);
    logger.info({ booking_id: saved.id, status: saved.status, call_id: ctx.callId }, "booking created from call");
    return {
      booked: true, booking_id: saved.id, status: saved.status, ...when,
      // AUTO_BOOK is false by design, so never promise a confirmed appointment on the call.
      say: `You're down for ${when.day} between ${when.window}. You'll get an email confirming it once our office checks the technician's route.`,
    };
  }));

  app.post("/opt_out", toolHandler("opt_out", async (c, msg, args) => {
    const { db } = c.get("deps");
    const phone = String(args["phone_e164"] ?? msg.call?.customer?.number ?? "");
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error("phone_e164 required");
    await suppress(db, {
      phoneE164: phone, reason: String(args["reason"] ?? "caller requested opt-out"), channel: "phone",
      artifact: { vapi_call_id: msg.call?.id, utterance: args["utterance"] },
    });
    return "Opt-out recorded. Apologize briefly, confirm they will not be called again, and end the call now.";
  }));

  return app;
}
