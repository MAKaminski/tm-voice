import { AdapterError, type Config, type Vendor, logger } from "@tm/shared";
import { z } from "zod";

export interface HealthResult {
  vendor: Vendor;
  ok: boolean;
  mode: "mock" | "real";
  detail?: string;
}

/** Every vendor adapter implements this. Do not invent a second shape. */
export interface Adapter {
  readonly name: Vendor;
  readonly mode: "mock" | "real";
  healthcheck(): Promise<HealthResult>;
}

export interface RetryOptions { attempts?: number; baseMs?: number; maxMs?: number }

/** Exponential backoff on AdapterError.retryable only. Non-retryable errors surface immediately. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4, base = opts.baseMs ?? 250, max = opts.maxMs ?? 8_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (!(e instanceof AdapterError) || !e.retryable || i === attempts - 1) throw e;
      const delay = Math.min(max, base * 2 ** i) + Math.random() * 100;
      logger.warn({ vendor: e.vendor, code: e.code, attempt: i + 1, delay }, "retrying adapter call");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function validate<S extends z.ZodTypeAny>(vendor: Vendor, schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AdapterError({ vendor, code: "invalid_input", retryable: false, raw: r.error.flatten() });
  return r.data;
}

/** Statuses worth retrying: rate limits, timeouts, and anything the vendor calls its own fault. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export interface RequestOptions {
  vendor: Vendor;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** Serialized as JSON unless `rawBody` is set. */
  body?: unknown;
  rawBody?: string | Uint8Array;
  query?: Record<string, string | number | boolean | undefined>;
  /** "json" parses the response, "void" discards it, "text" returns the raw string. */
  expect?: "json" | "void" | "text";
  retry?: RetryOptions;
  timeoutMs?: number;
}

/**
 * The one HTTP call every real adapter goes through: query building, JSON encode/decode,
 * a timeout, and status -> AdapterError mapping with consistent retryable semantics,
 * wrapped in withRetry. Adapters map vendor payloads; they never map transport errors.
 */
export async function request<T = unknown>(opts: RequestOptions): Promise<T> {
  const { vendor, method = "GET", expect = "json", timeoutMs = 15_000 } = opts;
  const url = new URL(opts.url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  let body: string | Uint8Array | undefined = opts.rawBody;
  if (body === undefined && opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }

  return withRetry(async () => {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal });
    } catch (e) {
      // Transport-level: DNS, reset, timeout. Always worth another attempt.
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new AdapterError({
        vendor, code: timedOut ? "timeout" : "network_error", retryable: true,
        message: `${vendor}: ${method} ${url.pathname} ${timedOut ? `timed out after ${timeoutMs}ms` : "failed"}`,
        raw: e instanceof Error ? e.message : e,
      });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new AdapterError({
        vendor, code: `http_${res.status}`, retryable: isRetryableStatus(res.status),
        message: `${vendor}: ${method} ${url.pathname} returned ${res.status}`,
        raw: detail.slice(0, 2_000),
      });
    }
    if (expect === "void") return undefined as T;
    if (expect === "text") return (await res.text()) as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AdapterError({
        vendor, code: "invalid_response", retryable: false,
        message: `${vendor}: ${method} ${url.pathname} returned non-JSON`, raw: text.slice(0, 500),
      });
    }
  }, opts.retry);
}

export function notImplemented(vendor: Vendor, method: string, because: string): never {
  throw new AdapterError({ vendor, code: "not_implemented", retryable: false, message: `${vendor}.${method}: ${because}` });
}

/** Records every method call so tests and dry runs can inspect what would have happened. */
export class MockRecorder {
  calls: { method: string; args: unknown[]; at: string }[] = [];
  record(method: string, ...args: unknown[]) { this.calls.push({ method, args, at: new Date().toISOString() }); }
  reset() { this.calls = []; }
}

/**
 * The DIAL_MODE rule. Lives here, imported ONLY by telnyx and vapi adapters (CLAUDE.md rule 5).
 * dry_run never reaches this code path (mocks are selected). verified_only requires the allowlist.
 */
export function assertDialAllowed(cfg: Pick<Config, "DIAL_MODE" | "DIAL_ALLOWLIST">, vendor: Vendor, toE164: string): void {
  if (cfg.DIAL_MODE === "dry_run") {
    throw new AdapterError({ vendor, code: "dial_mode_dry_run", retryable: false, message: "real dial attempted in dry_run" });
  }
  if (cfg.DIAL_MODE === "verified_only" && !cfg.DIAL_ALLOWLIST.includes(toE164)) {
    throw new AdapterError({ vendor, code: "dial_mode_not_allowlisted", retryable: false, message: `${toE164} not in DIAL_ALLOWLIST` });
  }
}

export function useMock(cfg: Config, ...keys: (keyof Config)[]): boolean {
  return cfg.DIAL_MODE === "dry_run" || keys.some((k) => !cfg[k]);
}

export const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 required");
