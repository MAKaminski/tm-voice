import { loadConfig } from "@tm/shared";
import { vi } from "vitest";

const base = { DATABASE_URL: "postgres://x", INTERNAL_API_TOKEN: "0123456789abcdef0123" };

/** Every vendor key, set to a placeholder. Outside dry_run the config loader requires all of them. */
const allKeysRaw = Object.fromEntries([
  "APOLLO_API_KEY", "HCP_API_KEY", "TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_PUBLIC_KEY", "VAPI_PRIVATE_KEY",
  "VAPI_WEBHOOK_SECRET", "VAPI_ASSISTANT_ID", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID",
  "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "RESEND_API_KEY", "MAIL_FROM", "MS_TENANT_ID", "MS_CLIENT_ID",
  "MS_CLIENT_CERT_PEM", "MS_BOOKING_MAILBOX", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET", "DNC_API_KEY",
  "DISCORD_BOT_TOKEN", "WATCH_CHANNEL_IDS", "STT_BATCH_PROVIDER", "STT_BATCH_API_KEY",
  "TMOS_SUPABASE_URL", "TMOS_SERVICE_KEY", "TMOS_BOARD_URL",
  // LLM_PROVIDER is overridden below: the llm adapter refuses to construct for a provider whose
  // wire format it does not speak, so a placeholder "x" would throw before any test runs.
].map((k) => [k, "x"]));
Object.assign(allKeysRaw, { LLM_PROVIDER: "anthropic" });
export const allKeys = allKeysRaw;

/** A config whose adapters are all in real mode. `over` replaces individual keys. */
export function realConfig(over: Record<string, string> = {}) {
  return loadConfig({ ...base, ...allKeys, REDIS_URL: "redis://x", DIAL_MODE: "live", ...over });
}

export interface RecordedCall { url: string; method: string; headers: Record<string, string>; body?: string; redirect?: RequestInit["redirect"] }

export interface StubResponse { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }

/**
 * Replaces global fetch for the duration of a test. `handler` returns the response for each
 * call; the recorded calls let a test assert on the request the adapter actually built.
 * Real adapters are written against vendor docs and cannot be exercised against a live API
 * until keys exist, so asserting the exact wire shape here is the only verification available.
 */
export function stubFetch(handler: (call: RecordedCall) => StubResponse | Promise<StubResponse>) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    // Adapters call fetch(url, init); the AWS SDK's fetch handler calls fetch(new Request(...)).
    const req = input instanceof Request ? input : undefined;
    const rawHeaders = init?.headers ?? req?.headers;
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) rawHeaders.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    else for (const [k, v] of Object.entries((rawHeaders ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = init?.body ?? (req ? await req.clone().text() : undefined);
    const call: RecordedCall = {
      url: String(req ? req.url : input),
      method: init?.method ?? req?.method ?? "GET",
      headers,
      body: typeof body === "string" && body.length ? body : undefined,
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    calls.push(call);
    const r = await handler(call);
    const status = r.status ?? 200;
    const text = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    // Only claim JSON when the test actually supplied JSON: the S3 SDK parses by content-type
    // and chokes on an empty body labelled application/json.
    const resHeaders = { ...(r.json === undefined ? {} : { "content-type": "application/json" }), ...r.headers };
    return new Response(status === 204 || !text ? null : text, { status, headers: resHeaders });
  });
  return calls;
}
