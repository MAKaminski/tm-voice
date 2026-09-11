import { loadConfig } from "@tm/shared";
import { vi } from "vitest";

const base = { DATABASE_URL: "postgres://x", INTERNAL_API_TOKEN: "0123456789abcdef0123" };

/** Every vendor key, set to a placeholder. Outside dry_run the config loader requires all of them. */
export const allKeys = Object.fromEntries([
  "APOLLO_API_KEY", "HCP_API_KEY", "TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_PUBLIC_KEY", "VAPI_PRIVATE_KEY",
  "VAPI_WEBHOOK_SECRET", "VAPI_ASSISTANT_ID", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID",
  "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "RESEND_API_KEY", "MAIL_FROM", "MS_TENANT_ID", "MS_CLIENT_ID",
  "MS_CLIENT_CERT_PEM", "MS_BOOKING_MAILBOX", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET", "DNC_API_KEY",
].map((k) => [k, "x"]));

/** A config whose adapters are all in real mode. `over` replaces individual keys. */
export function realConfig(over: Record<string, string> = {}) {
  return loadConfig({ ...base, ...allKeys, REDIS_URL: "redis://x", DIAL_MODE: "live", ...over });
}

export interface RecordedCall { url: string; method: string; headers: Record<string, string>; body?: string }

export interface StubResponse { status?: number; json?: unknown; text?: string }

/**
 * Replaces global fetch for the duration of a test. `handler` returns the response for each
 * call; the recorded calls let a test assert on the request the adapter actually built.
 * Real adapters are written against vendor docs and cannot be exercised against a live API
 * until keys exist, so asserting the exact wire shape here is the only verification available.
 */
export function stubFetch(handler: (call: RecordedCall) => StubResponse | Promise<StubResponse>) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const r = await handler(call);
    const status = r.status ?? 200;
    const text = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}
