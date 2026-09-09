import type { Config } from "@tm/shared";
import { type Adapter, MockRecorder, notImplemented, useMock } from "../base.js";

export interface DncAdapter extends Adapter {
  lookup(phoneE164: string): Promise<{ federal: boolean; state: boolean }>;
}

/** Mock DNC fixture list. Add numbers here to simulate a registry hit in tests/dry runs. */
export const MOCK_DNC_NUMBERS = new Set<string>(["+14045550198"]);

export function createDncAdapter(cfg: Config): DncAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "DNC_API_KEY")) {
    const mock = new MockRecorder();
    return {
      name: "dnc", mode: "mock", mock,
      async healthcheck() { return { vendor: "dnc", ok: true, mode: "mock" as const }; },
      async lookup(p) { mock.record("lookup", p); return { federal: MOCK_DNC_NUMBERS.has(p), state: false }; },
    };
  }
  return {
    name: "dnc", mode: "real",
    async healthcheck() { return { vendor: "dnc", ok: false, mode: "real", detail: "DoNotCallDNC client lands in Phase 3" }; },
    async lookup() { return notImplemented("dnc", "lookup"); },
  };
}
