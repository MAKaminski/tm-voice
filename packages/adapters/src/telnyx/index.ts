import type { Config, LineType } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, assertDialAllowed, e164, notImplemented, useMock, validate } from "../base.js";

export const dialInput = z.object({ to: e164, from: e164, call_task_id: z.string().uuid() });
export type DialInput = z.infer<typeof dialInput>;

export interface TelnyxAdapter extends Adapter {
  lookupLineType(phoneE164: string): Promise<{ line_type: LineType; carrier?: string }>;
  /** Only used if we ever bypass Vapi's BYO-SIP origination. Enforces DIAL_MODE. */
  dial(input: DialInput): Promise<{ call_control_id: string }>;
  verifyWebhook(signature: string | undefined, timestamp: string | undefined, rawBody: string): boolean;
}

/** Mock line-type fixture: area code 678 → wireless, everything else landline (matches db seed). */
export function mockLineType(phone: string): LineType {
  if (phone.startsWith("+1678") || phone.startsWith("+1470")) return "wireless";
  if (phone.startsWith("+1800")) return "voip";
  return "landline";
}

export function createTelnyxAdapter(cfg: Config): TelnyxAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_PUBLIC_KEY")) {
    const mock = new MockRecorder();
    return {
      name: "telnyx", mode: "mock", mock,
      async healthcheck() { return { vendor: "telnyx", ok: true, mode: "mock" as const }; },
      async lookupLineType(p) { mock.record("lookupLineType", p); return { line_type: mockLineType(p), carrier: "mock" }; },
      async dial(input) {
        const v = validate("telnyx", dialInput, input);
        mock.record("dial", v);
        return { call_control_id: `mock_cc_${mock.calls.length}` };
      },
      verifyWebhook() { return true; },
    };
  }
  return {
    name: "telnyx", mode: "real",
    async healthcheck() {
      const r = await fetch("https://api.telnyx.com/v2/balance", { headers: { Authorization: `Bearer ${cfg.TELNYX_API_KEY!}` } });
      return { vendor: "telnyx", ok: r.ok, mode: "real", detail: r.ok ? undefined : `HTTP ${r.status}` };
    },
    async lookupLineType() { return notImplemented("telnyx", "lookupLineType"); },
    async dial(input) {
      const v = validate("telnyx", dialInput, input);
      assertDialAllowed(cfg, "telnyx", v.to);
      return notImplemented("telnyx", "dial");
    },
    verifyWebhook() { return notImplemented("telnyx", "verifyWebhook"); },
  };
}
