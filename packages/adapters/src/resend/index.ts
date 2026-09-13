import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, request, useMock, validate } from "../base.js";

export const sendEmailInput = z.object({
  to: z.string().email(),
  subject: z.string(),
  html: z.string(),
  template: z.string(),
  /** Resend `Idempotency-Key` header — Resend caps it at 256 chars and dedupes for 24h. */
  idempotency_key: z.string().min(1).max(256),
});
export type SendEmailInput = z.infer<typeof sendEmailInput>;

export interface ResendAdapter extends Adapter {
  sendEmail(input: SendEmailInput): Promise<{ id: string }>;
}

export function createResendAdapter(cfg: Config): ResendAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "RESEND_API_KEY", "MAIL_FROM")) {
    const mock = new MockRecorder();
    const seen = new Map<string, string>();
    return {
      name: "resend", mode: "mock", mock,
      async healthcheck() { return { vendor: "resend", ok: true, mode: "mock" as const }; },
      async sendEmail(input) {
        const v = validate("resend", sendEmailInput, input);
        mock.record("sendEmail", v);
        const id = seen.get(v.idempotency_key) ?? `mock_email_${seen.size + 1}`;
        seen.set(v.idempotency_key, id);
        return { id };
      },
    };
  }
  return {
    name: "resend", mode: "real",
    async healthcheck() {
      const r = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY!}` } });
      if (r.ok) return { vendor: "resend", ok: true, mode: "real" };
      // docs/CREDENTIALS.md scopes the key to sending_access, and Resend answers GET /domains for such a key with
      // 401 restricted_api_key. That proves the key authenticates, so it is healthy; any other 401 is a bad key.
      const body = (await r.json().catch(() => ({}))) as { name?: string };
      if (r.status === 401 && body.name === "restricted_api_key") return { vendor: "resend", ok: true, mode: "real", detail: "sending-only key" };
      return { vendor: "resend", ok: false, mode: "real", detail: `HTTP ${r.status}` };
    },
    async sendEmail(input) {
      const v = validate("resend", sendEmailInput, input);
      const res = await request<{ id?: string }>({
        vendor: "resend", method: "POST", url: "https://api.resend.com/emails",
        // Resend dedupes on Idempotency-Key for 24h, so a retried job cannot send twice.
        headers: { authorization: `Bearer ${cfg.RESEND_API_KEY!}`, "idempotency-key": v.idempotency_key },
        body: { from: cfg.MAIL_FROM!, to: v.to, subject: v.subject, html: v.html },
      });
      if (!res.id) throw new AdapterError({ vendor: "resend", code: "missing_email_id", retryable: false, raw: res });
      return { id: res.id };
    },
  };
}
