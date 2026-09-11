import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { AdapterError, type Config, type LineType } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, assertDialAllowed, e164, request, useMock, validate } from "../base.js";

const API = "https://api.telnyx.com/v2";

/**
 * Telnyx `carrier.type` -> our LineType. Deliberately conservative: only an unambiguous
 * fixed line maps to "landline", because landline_only treats "landline" as the single
 * dialable value (packages/compliance/src/surface.ts). "fixed line or mobile" could be a
 * cell, so it must not unlock a dial; everything unrecognised falls through to "unknown".
 */
export function mapCarrierType(type: string | undefined): LineType {
  switch (type) {
    case "fixed line": return "landline";
    case "mobile": return "wireless";
    case "voip": return "voip";
    default: return "unknown";
  }
}

/** Telnyx publishes a bare 32-byte Ed25519 key in base64; Node needs SPKI DER. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function ed25519KeyFromBase64(publicKeyB64: string) {
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) throw new AdapterError({ vendor: "telnyx", code: "invalid_public_key", retryable: false, message: "TELNYX_PUBLIC_KEY must be a base64 32-byte Ed25519 key" });
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Replay window for webhook timestamps, matching the Telnyx SDK default. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Verifies a Telnyx webhook: Ed25519 over `${telnyx-timestamp}|${rawBody}`, signature and
 * public key both base64. Returns false rather than throwing so callers answer 4xx.
 */
export function telnyxWebhookOk(
  publicKeyB64: string,
  signatureB64: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  now = Date.now(),
): boolean {
  if (!signatureB64 || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
  } catch { return false; }
  if (sig.length !== 64) return false;
  try {
    return cryptoVerify(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), ed25519KeyFromBase64(publicKeyB64), sig);
  } catch { return false; }
}

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
  const auth = { authorization: `Bearer ${cfg.TELNYX_API_KEY!}` };
  return {
    name: "telnyx", mode: "real",
    async healthcheck() {
      const r = await fetch("https://api.telnyx.com/v2/balance", { headers: { Authorization: `Bearer ${cfg.TELNYX_API_KEY!}` } });
      return { vendor: "telnyx", ok: r.ok, mode: "real", detail: r.ok ? undefined : `HTTP ${r.status}` };
    },
    async lookupLineType(phoneE164) {
      const p = validate("telnyx", e164, phoneE164);
      const res = await request<{ data?: { carrier?: { type?: string; name?: string; normalized_carrier?: string } } }>({
        vendor: "telnyx", url: `${API}/number_lookup/${encodeURIComponent(p)}`, query: { type: "carrier" }, headers: auth,
      });
      const carrier = res.data?.carrier;
      return { line_type: mapCarrierType(carrier?.type), carrier: carrier?.normalized_carrier ?? carrier?.name };
    },
    async dial(input) {
      const v = validate("telnyx", dialInput, input);
      assertDialAllowed(cfg, "telnyx", v.to);
      const res = await request<{ data?: { call_control_id?: string } }>({
        vendor: "telnyx", method: "POST", url: `${API}/calls`, headers: auth,
        body: {
          connection_id: cfg.TELNYX_CONNECTION_ID!,
          to: v.to,
          from: v.from,
          // Telnyx drops a repeated command_id, so a retried job cannot place a second call.
          command_id: v.call_task_id,
        },
      });
      const id = res.data?.call_control_id;
      if (!id) throw new AdapterError({ vendor: "telnyx", code: "missing_call_control_id", retryable: false, raw: res });
      return { call_control_id: id };
    },
    verifyWebhook(signature, timestamp, rawBody) {
      return telnyxWebhookOk(cfg.TELNYX_PUBLIC_KEY!, signature, timestamp, rawBody);
    },
  };
}
