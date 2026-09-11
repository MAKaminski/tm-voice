import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, type HealthResult, MockRecorder, e164, request, useMock, validate } from "../base.js";

const API = "https://api.apollo.io/api/v1";
/** Apollo caps a contact search page at 100 and the whole result set at 500 pages. */
const PAGE_SIZE = 100;
const MAX_PAGES = 500;

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
    async logPhoneCall(input, idempotencyKey) {
      const v = validate("apollo", logPhoneCallInput, input);
      // Apollo documents these as query parameters on POST /phone_calls, not as a JSON body.
      // Apollo offers no idempotency header, so `idempotencyKey` cannot be enforced vendor-side;
      // the postcall job's own idempotency_key is what stops a replay from logging twice.
      const res = await request<{ phone_call?: { id?: string } }>({
        vendor: "apollo", method: "POST", url: `${API}/phone_calls`,
        headers: { "x-api-key": cfg.APOLLO_API_KEY! },
        query: {
          logged: true,
          contact_id: v.contact_id, account_id: v.account_id,
          to_number: v.to_number, from_number: v.from_number,
          status: v.status, start_time: v.start_time, end_time: v.end_time, duration: v.duration,
          phone_call_outcome_id: v.phone_call_outcome_id, note: v.note,
        },
      });
      const id = res.phone_call?.id;
      if (!id) throw new AdapterError({ vendor: "apollo", code: "missing_phone_call_id", retryable: false, raw: { key: idempotencyKey, res } });
      return { id };
    },
    async updateAccountStage(apolloAccountId, stageId) {
      await request({
        vendor: "apollo", method: "PATCH", url: `${API}/accounts/${encodeURIComponent(apolloAccountId)}`,
        headers: { "x-api-key": cfg.APOLLO_API_KEY! }, query: { account_stage_id: stageId }, expect: "void",
      });
    },
    async listSavedSearchContacts(savedSearchId) {
      const out: { id: string; phone?: string; first_name?: string; last_name?: string; email?: string; organization_id?: string }[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await request<{
          contacts?: { id?: string; phone_numbers?: { sanitized_number?: string; raw_number?: string }[]; first_name?: string; last_name?: string; email?: string; organization_id?: string }[];
          pagination?: { total_pages?: number };
        }>({
          vendor: "apollo", method: "POST", url: `${API}/contacts/search`,
          headers: { "x-api-key": cfg.APOLLO_API_KEY! },
          body: { contact_label_ids: [savedSearchId], page, per_page: PAGE_SIZE },
        });
        for (const c of res.contacts ?? []) {
          if (!c.id) continue;
          const phones = c.phone_numbers ?? [];
          out.push({
            id: c.id,
            phone: phones[0]?.sanitized_number ?? phones[0]?.raw_number,
            first_name: c.first_name, last_name: c.last_name, email: c.email, organization_id: c.organization_id,
          });
        }
        const totalPages = res.pagination?.total_pages ?? 1;
        if (!res.contacts?.length || page >= totalPages) break;
      }
      return out;
    },
  };
}
