import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, assertDialAllowed, e164, notImplemented, useMock, validate } from "../base.js";

export const outboundCallInput = z.object({
  to: e164,
  from: e164,
  assistant_id: z.string(),
  metadata: z.object({ call_task_id: z.string().uuid(), contact_id: z.string().uuid() }),
});
export type OutboundCallInput = z.infer<typeof outboundCallInput>;

export interface VapiAdapter extends Adapter {
  createOutboundCall(input: OutboundCallInput): Promise<{ id: string; synthetic: boolean }>;
  getCall(id: string): Promise<{ id: string; status: string; recording_url?: string; transcript?: unknown }>;
  /**
   * Verifies a Vapi server webhook. Vapi sends the configured server secret as `x-vapi-secret`;
   * an HMAC-SHA256 in `x-vapi-signature` is also accepted for forward compatibility.
   */
  verifyWebhook(headers: { secret?: string; signature?: string }, rawBody: string): boolean;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function webhookOk(secret: string, headers: { secret?: string; signature?: string }, rawBody: string): boolean {
  if (headers.secret && safeEq(headers.secret, secret)) return true;
  if (headers.signature) return safeEq(createHmac("sha256", secret).update(rawBody).digest("hex"), headers.signature);
  return false;
}

export function createVapiAdapter(cfg: Config): VapiAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "VAPI_PRIVATE_KEY", "VAPI_WEBHOOK_SECRET", "VAPI_ASSISTANT_ID")) {
    const mock = new MockRecorder();
    const secret = cfg.VAPI_WEBHOOK_SECRET ?? "mock-vapi-secret";
    return {
      name: "vapi", mode: "mock", mock,
      async healthcheck() { return { vendor: "vapi", ok: true, mode: "mock" as const }; },
      async createOutboundCall(input) {
        const v = validate("vapi", outboundCallInput, input);
        mock.record("createOutboundCall", v);
        // dry_run: never network. Return a synthetic call the worker records as disposition=dry_run.
        return { id: `dryrun_${v.metadata.call_task_id}`, synthetic: true };
      },
      async getCall(id) { mock.record("getCall", id); return { id, status: "ended" }; },
      verifyWebhook(h, body) { return webhookOk(secret, h, body); },
    };
  }
  return {
    name: "vapi", mode: "real",
    async healthcheck() {
      const r = await fetch(`https://api.vapi.ai/assistant/${cfg.VAPI_ASSISTANT_ID!}`, { headers: { Authorization: `Bearer ${cfg.VAPI_PRIVATE_KEY!}` } });
      return { vendor: "vapi", ok: r.ok, mode: "real", detail: r.ok ? undefined : `HTTP ${r.status}` };
    },
    async createOutboundCall(input) {
      const v = validate("vapi", outboundCallInput, input);
      assertDialAllowed(cfg, "vapi", v.to);
      return notImplemented("vapi", "createOutboundCall");
    },
    async getCall() { return notImplemented("vapi", "getCall"); },
    verifyWebhook(h, body) { return webhookOk(cfg.VAPI_WEBHOOK_SECRET!, h, body); },
  };
}
