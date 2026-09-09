import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { suppress } from "@tm/compliance";
import type { AppEnv } from "../app.js";
import { vapiAuth } from "../middleware.js";

/** Vapi server-message envelope for tool calls (subset). */
const toolCallMessage = z.object({
  message: z.object({
    type: z.literal("tool-calls"),
    call: z.object({ id: z.string(), metadata: z.record(z.unknown()).optional(), customer: z.object({ number: z.string() }).optional() }).optional(),
    toolCalls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.union([z.record(z.unknown()), z.string()]) }) })),
  }),
});

const seen = new Map<string, unknown>(); // idempotency on call_id + tool + args hash (Redis-backed in Phase 4)
const idem = (callId: string, tool: string, args: unknown) => `${callId}:${tool}:${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16)}`;

/**
 * Agent tool endpoints called by Vapi. All verify the webhook secret; all idempotent on call_id + tool + args hash.
 * Phase 2 ships opt_out fully (it is compliance). get_availability / book_job / send_packet return 501 until Phase 4.
 */
export function toolRoutes() {
  const app = new Hono<AppEnv>().use(vapiAuth);

  for (const tool of ["get_availability", "book_job", "send_packet"]) {
    app.post(`/${tool}`, (c) => c.json({ error: "not_implemented", tool, phase: 4 }, 501));
  }

  app.post("/opt_out", async (c) => {
    const raw = c.get("rawBody" as never) as string;
    const p = toolCallMessage.safeParse(JSON.parse(raw || "{}"));
    if (!p.success) return c.json({ error: "invalid_body", issues: p.error.flatten() }, 400);
    const { db } = c.get("deps");
    const callId = p.data.message.call?.id ?? "unknown";
    const results = [];
    for (const tc of p.data.message.toolCalls) {
      const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      const key = idem(callId, "opt_out", args);
      if (seen.has(key)) { results.push({ toolCallId: tc.id, result: seen.get(key) }); continue; }
      const phone = String(args.phone_e164 ?? p.data.message.call?.customer?.number ?? "");
      if (!/^\+[1-9]\d{6,14}$/.test(phone)) { results.push({ toolCallId: tc.id, error: "phone_e164 required" }); continue; }
      await suppress(db, { phoneE164: phone, reason: String(args.reason ?? "caller requested opt-out"), channel: "phone", artifact: { vapi_call_id: callId, utterance: args.utterance } });
      const result = "Opt-out recorded. Apologize briefly, confirm they will not be called again, and end the call now.";
      seen.set(key, result);
      results.push({ toolCallId: tc.id, result });
    }
    return c.json({ results });
  });
  return app;
}
