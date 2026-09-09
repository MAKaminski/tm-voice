import type { Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, notImplemented, useMock, validate } from "../base.js";

export const sendEmailInput = z.object({
  to: z.string().email(),
  subject: z.string(),
  html: z.string(),
  template: z.string(),
  /** Resend `Idempotency-Key` header. */
  idempotency_key: z.string(),
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
      return { vendor: "resend", ok: r.ok, mode: "real", detail: r.ok ? undefined : `HTTP ${r.status}` };
    },
    async sendEmail() { return notImplemented("resend", "sendEmail"); },
  };
}
