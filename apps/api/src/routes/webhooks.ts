import { Hono } from "hono";
import { idempotencyKey } from "@tm/shared";
import type { AppEnv } from "../app.js";

/** HCP: job.scheduled / job.completed / customer.updated / pro.created → invalidate availability and re-materialize. */
export function webhookRoutes() {
  return new Hono<AppEnv>().post("/hcp", async (c) => {
    const { adapters, producer } = c.get("deps");
    const raw = await c.req.text();
    if (!adapters.hcp.verifyWebhook(c.req.header("x-hcp-signature"), raw)) return c.json({ error: "bad_signature" }, 401);
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
