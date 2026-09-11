import { AdapterError, type Config } from "@tm/shared";
import { type Adapter, MockRecorder, request, useMock } from "../base.js";

export interface DncAdapter extends Adapter {
  lookup(phoneE164: string): Promise<{ federal: boolean; state: boolean }>;
}

/** Mock DNC fixture list. Add numbers here to simulate a registry hit in tests/dry runs. */
export const MOCK_DNC_NUMBERS = new Set<string>(["+14045550198"]);

/**
 * DoNotCallDNC takes a bare 10-digit NANP number. Anything that is not a +1 number cannot be
 * checked by this vendor, and an unchecked number must never be reported as clean.
 */
export function toNanp10(phoneE164: string): string {
  const m = /^\+1(\d{10})$/.exec(phoneE164);
  if (!m) {
    throw new AdapterError({
      vendor: "dnc", code: "unsupported_number", retryable: false,
      message: `${phoneE164} is not a +1 NANP number; DoNotCallDNC only covers US numbers`,
    });
  }
  return m[1]!;
}

export function createDncAdapter(cfg: Config): DncAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "DNC_API_KEY")) {
    const mock = new MockRecorder();
    return {
      name: "dnc", mode: "mock", mock,
      async healthcheck() { return { vendor: "dnc", ok: true, mode: "mock" as const }; },
      async lookup(p) { mock.record("lookup", p); return { federal: MOCK_DNC_NUMBERS.has(p), state: false }; },
    };
  }
  const auth = { "x-api-key": cfg.DNC_API_KEY! };
  return {
    name: "dnc", mode: "real",
    async healthcheck() {
      // No dedicated health route; a known-good lookup is the cheapest probe and reports credits.
      try {
        const r = await request<{ success?: boolean; credits_remaining?: number }>({
          vendor: "dnc", url: "https://www.donotcalldnc.com/api/v1/check-1/", query: { phone: "2025550123" }, headers: auth, retry: { attempts: 1 },
        });
        return { vendor: "dnc", ok: r?.success === true, mode: "real", detail: r?.credits_remaining !== undefined ? `${r.credits_remaining} credits` : "unexpected response" };
      } catch (e) {
        return { vendor: "dnc", ok: false, mode: "real", detail: e instanceof Error ? e.message : "lookup failed" };
      }
    },
    async lookup(phoneE164) {
      const res = await request<{ success?: boolean; is_dnc?: boolean; status?: string }>({
        vendor: "dnc", url: "https://www.donotcalldnc.com/api/v1/check-1/", query: { phone: toNanp10(phoneE164) }, headers: auth,
      });
      // Fail closed: an unsuccessful or unparseable answer must not read as "not on the registry".
      if (res?.success !== true || typeof res.is_dnc !== "boolean") {
        throw new AdapterError({ vendor: "dnc", code: "inconclusive_lookup", retryable: true, message: `DNC lookup for ${phoneE164} was inconclusive`, raw: res });
      }
      // This vendor returns a single federal determination; it exposes no state registry data,
      // so `state` stays false and state-level scrubbing remains an open compliance gap.
      return { federal: res.is_dnc, state: false };
    },
  };
}
