import { Hono } from "hono";
import { z } from "zod";
import { call } from "@tm/db";
import { eq } from "drizzle-orm";
import { idempotencyKey, logger } from "@tm/shared";
import type { AppEnv } from "../app.js";
import { vapiAuth } from "../middleware.js";

/** Vapi server message, end-of-call-report subset. Other message types (status-update) are acknowledged and dropped. */
const vapiMessage = z.object({
  message: z.object({
    type: z.string(),
    endedReason: z.string().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    cost: z.number().optional(),
    call: z.object({ id: z.string(), name: z.string().optional() }).passthrough().optional(),
    analysis: z.object({ summary: z.string().optional(), structuredData: z.record(z.unknown()).optional() }).passthrough().optional(),
    artifact: z.object({
      messages: z.array(z.object({ role: z.string(), message: z.string().optional(), secondsFromStart: z.number().optional() }).passthrough()).optional(),
      /** Mono first, stereo as the fallback — the same preference `vapi.getCall` applies. */
      recordingUrl: z.string().url().optional(),
      stereoRecordingUrl: z.string().url().optional(),
    }).passthrough().optional(),
  }).passthrough(),
});

/**
 * The Telnyx call-event envelope, reduced to what we keep. `.passthrough()` everywhere because
 * Telnyx adds fields without notice and a strict schema would start rejecting live deliveries.
 */
const telnyxEvent = z.object({
  data: z.object({
    event_type: z.string(),
    payload: z.object({
      call_control_id: z.string().optional(),
      /** The dialer stamps the call_task id here, so an event can be tied back without a phone number. */
      command_id: z.string().optional(),
      hangup_cause: z.string().optional(),
      answered_at: z.string().optional(),
      end_time: z.string().optional(),
      call_cost: z.object({ amount: z.string().optional(), currency: z.string().optional() }).passthrough().optional(),
    }).passthrough().optional().default({}),
  }).passthrough(),
});

const ROLE: Record<string, "assistant" | "customer" | "tool"> = { bot: "assistant", assistant: "assistant", user: "customer", tool_calls: "tool", tool_call_result: "tool" };

/** Reduces a Vapi end-of-call-report to the postcall.process payload. Exported for tests. */
export function postcallPayloadFrom(msg: z.infer<typeof vapiMessage>["message"]) {
  const name = msg.call?.name;
  const recordingUrl = msg.artifact?.recordingUrl ?? msg.artifact?.stereoRecordingUrl;
  const turns = (msg.artifact?.messages ?? [])
    .filter((m) => ROLE[m.role])
    .map((m) => ({ role: ROLE[m.role]!, text: String(m.message ?? ""), at_sec: Math.round((m.secondsFromStart ?? 0) * 10) / 10 }));
  return {
    vapi_call_id: msg.call!.id,
    ...(name && /^[0-9a-f-]{36}$/i.test(name) ? { call_task_id: name } : {}),
    ended_reason: msg.endedReason ?? "unknown",
    ...(msg.startedAt ? { started_at: msg.startedAt } : {}),
    ...(msg.endedAt ? { ended_at: msg.endedAt } : {}),
    ...(msg.cost !== undefined ? { cost_usd: msg.cost } : {}),
    ...(msg.analysis?.summary ? { summary: msg.analysis.summary } : {}),
    ...(msg.analysis?.structuredData ? { structured: msg.analysis.structuredData } : {}),
    // Previously dropped at the door: the URL arrived on every report and nothing read it, so no
    // call recording was ever stored despite the disclosure line promising one.
    ...(recordingUrl ? { recording_url: recordingUrl } : {}),
    turns,
  };
}

/** HCP: job.scheduled / job.completed / customer.updated / pro.created → invalidate availability and re-materialize. */
export function webhookRoutes() {
  const app = new Hono<AppEnv>();

  /** Vapi assistant server URL: end-of-call-report → postcall.process (one job per call). */
  app.post("/vapi", vapiAuth, async (c) => {
    const raw = c.get("rawBody" as never) as string;
    const parsed = vapiMessage.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const msg = parsed.data.message;
    if (msg.type !== "end-of-call-report" || !msg.call?.id) return c.json({ ok: true, ignored: msg.type });
    const now = new Date().toISOString();
    const payload = postcallPayloadFrom(msg);
    await c.get("deps").producer.enqueue("postcall", "process", {
      entity_id: payload.vapi_call_id, idempotency_key: idempotencyKey("postcall", payload.vapi_call_id), attempt: 0, enqueued_at: now, ...payload,
    });
    logger.info({ vapi_call_id: payload.vapi_call_id, ended_reason: payload.ended_reason }, "end-of-call report queued");
    return c.json({ ok: true });
  });

  /**
   * Telnyx call events. This route did not exist: `telnyxWebhookOk()` was written and tested, the
   * adapter wrapped it, `docs/CREDENTIALS.md` told Michael to put this URL in the Telnyx Voice
   * Application — and Telnyx's deliveries hit a 404.
   *
   * What it is for, now that it exists: Telnyx knows things Vapi's end-of-call report does not.
   * The carrier's own hangup cause, when the callee actually answered, and the per-leg cost that
   * `docs/RUNBOOK.md` §7 says is the only way to replace the cost-per-dial assumptions with
   * measurements. Vapi reports its own view of the call; this is the network's.
   *
   * Fails closed on a bad signature, the way /hcp does. The Ed25519 check also enforces a
   * five-minute replay window, so a captured delivery cannot be resent later.
   */
  app.post("/telnyx", async (c) => {
    const { adapters, db } = c.get("deps");
    const raw = await c.req.text();
    if (!adapters.telnyx.verifyWebhook(c.req.header("telnyx-signature-ed25519"), c.req.header("telnyx-timestamp"), raw)) {
      return c.json({ error: "bad_signature" }, 401);
    }
    const parsed = telnyxEvent.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

    const { event_type: eventType, payload } = parsed.data.data;
    const controlId = payload?.call_control_id;
    // command_id is the call_task id the dialer stamped (telnyx.dial sets it), which is how an
    // event is tied back to a call without trusting the phone number.
    if (!controlId) return c.json({ ok: true, ignored: eventType });

    const patch: Partial<typeof call.$inferInsert> = { telnyxCallControlId: controlId, updatedAt: new Date() };
    if (eventType === "call.answered" && payload.answered_at) patch.startedAt = new Date(payload.answered_at);
    if (eventType === "call.hangup") {
      if (payload.hangup_cause) patch.telnyxHangupCause = payload.hangup_cause;
      if (payload.end_time) patch.endedAt = new Date(payload.end_time);
    }
    // Telnyx reports its leg's cost separately from Vapi's platform cost; they are not the same
    // number and adding them here would double-count. Stored on its own column.
    if (payload.call_cost?.amount) patch.telnyxCostUsd = String(payload.call_cost.amount);

    // Match on command_id first — the dialer's own correlation id — and fall back to the control id
    // for an event that arrives before we have seen one.
    const where = payload.command_id && /^[0-9a-f-]{36}$/i.test(payload.command_id)
      ? eq(call.callTaskId, payload.command_id)
      : eq(call.telnyxCallControlId, controlId);
    const updated = await db.update(call).set(patch).where(where).returning({ id: call.id });
    if (!updated.length) {
      // Not an error: Telnyx can beat our own insert, and a second delivery will land after it.
      logger.info({ event_type: eventType, call_control_id: controlId }, "telnyx event for a call not yet recorded");
      return c.json({ ok: true, matched: 0, event: eventType });
    }
    logger.info({ event_type: eventType, call_id: updated[0]!.id, hangup_cause: payload.hangup_cause }, "telnyx event recorded");
    return c.json({ ok: true, matched: updated.length, event: eventType });
  });

  return app.post("/hcp", async (c) => {
    const { adapters, producer } = c.get("deps");
    const raw = await c.req.text();
    if (!adapters.hcp.verifyWebhook(c.req.header("x-housecallpro-signature"), raw)) return c.json({ error: "bad_signature" }, 401);
    const body = JSON.parse(raw || "{}") as { event?: string; id?: string };
    const event = body.event ?? "unknown";
    await c.get("availability").invalidate();
    if (event.startsWith("job.") || event === "pro.created") {
      const now = new Date().toISOString();
      await producer.enqueue("availability", "materialize", { entity_id: body.id ?? event, idempotency_key: idempotencyKey("availability", event, body.id ?? now), attempt: 0, enqueued_at: now, reason: event });
    }
    return c.json({ ok: true, event });
  });
}
