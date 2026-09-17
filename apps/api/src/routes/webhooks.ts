import { Hono } from "hono";
import { z } from "zod";
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
