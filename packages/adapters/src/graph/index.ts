import type { Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, notImplemented, useMock, validate } from "../base.js";

export const createEventInput = z.object({
  subject: z.string(),
  body_html: z.string(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  timezone: z.string(),
  location: z.string(),
  attendees: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).min(1),
  /** Graph `transactionId` — makes createEvent idempotent. */
  transaction_id: z.string(),
});
export type CreateEventInput = z.infer<typeof createEventInput>;

export interface GraphAdapter extends Adapter {
  createEvent(input: CreateEventInput): Promise<{ id: string }>;
  getRsvp(eventId: string): Promise<{ email: string; status: string }[]>;
}

export function createGraphAdapter(cfg: Config): GraphAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_CERT_PEM", "MS_BOOKING_MAILBOX")) {
    const mock = new MockRecorder();
    const seen = new Map<string, string>();
    return {
      name: "graph", mode: "mock", mock,
      async healthcheck() { return { vendor: "graph", ok: true, mode: "mock" as const }; },
      async createEvent(input) {
        const v = validate("graph", createEventInput, input);
        mock.record("createEvent", v);
        const id = seen.get(v.transaction_id) ?? `mock_evt_${seen.size + 1}`;
        seen.set(v.transaction_id, id);
        return { id };
      },
      async getRsvp(id) { mock.record("getRsvp", id); return []; },
    };
  }
  return {
    name: "graph", mode: "real",
    async healthcheck() { return { vendor: "graph", ok: false, mode: "real", detail: "client-credential flow lands in Phase 3" }; },
    async createEvent() { return notImplemented("graph", "createEvent"); },
    async getRsvp() { return notImplemented("graph", "getRsvp"); },
  };
}
