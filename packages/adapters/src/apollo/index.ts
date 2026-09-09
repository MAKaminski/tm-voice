import type { Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, type HealthResult, MockRecorder, e164, notImplemented, useMock, validate } from "../base.js";

export const logPhoneCallInput = z.object({
  contact_id: z.string().optional(),
  account_id: z.string().optional(),
  to_number: e164,
  from_number: e164,
  status: z.string(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  duration: z.number().int().nonnegative(),
  phone_call_outcome_id: z.string().optional(),
  /** Summary + signed recording link. Apollo has no recording field; this is the settled workaround. */
  note: z.string().max(10_000),
});
export type LogPhoneCallInput = z.infer<typeof logPhoneCallInput>;

export interface ApolloAdapter extends Adapter {
  logPhoneCall(input: LogPhoneCallInput, idempotencyKey: string): Promise<{ id: string }>;
  updateAccountStage(apolloAccountId: string, stageId: string): Promise<void>;
  listSavedSearchContacts(savedSearchId: string): Promise<{ id: string; phone?: string; first_name?: string; last_name?: string; email?: string; organization_id?: string }[]>;
}

export function createApolloAdapter(cfg: Config): ApolloAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "APOLLO_API_KEY")) {
    const mock = new MockRecorder();
    const seen = new Map<string, string>();
    return {
      name: "apollo", mode: "mock", mock,
      async healthcheck(): Promise<HealthResult> { return { vendor: "apollo", ok: true, mode: "mock" }; },
      async logPhoneCall(input, key) {
        validate("apollo", logPhoneCallInput, input);
        mock.record("logPhoneCall", input, key);
        const id = seen.get(key) ?? `mock_pc_${seen.size + 1}`;
        seen.set(key, id);
        return { id };
      },
      async updateAccountStage(a, s) { mock.record("updateAccountStage", a, s); },
      async listSavedSearchContacts(id) { mock.record("listSavedSearchContacts", id); return []; },
    };
  }
  return {
    name: "apollo", mode: "real",
    async healthcheck() {
      const r = await fetch("https://api.apollo.io/api/v1/auth/health", { headers: { "x-api-key": cfg.APOLLO_API_KEY! } });
      return { vendor: "apollo", ok: r.ok, mode: "real", detail: r.ok ? undefined : `HTTP ${r.status}` };
    },
    async logPhoneCall() { return notImplemented("apollo", "logPhoneCall"); },
    async updateAccountStage() { return notImplemented("apollo", "updateAccountStage"); },
    async listSavedSearchContacts() { return notImplemented("apollo", "listSavedSearchContacts"); },
  };
}
