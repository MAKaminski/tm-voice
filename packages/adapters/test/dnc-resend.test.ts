import { afterEach, describe, expect, it, vi } from "vitest";
import { createDncAdapter, createResendAdapter, toNanp10 } from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("dnc real adapter", () => {
  it("calls the documented endpoint with a 10-digit number and the key header", async () => {
    const calls = stubFetch(() => ({ json: { success: true, phone: "4045550100", is_dnc: true, status: "DNC", credits_remaining: 10 } }));
    const d = createDncAdapter(realConfig({ DNC_API_KEY: "dnc_k" }));
    expect(d.mode).toBe("real");
    await expect(d.lookup("+14045550100")).resolves.toEqual({ federal: true, state: false });
    expect(calls[0]!.url).toBe("https://www.donotcalldnc.com/api/v1/check-1/?phone=4045550100");
    expect(calls[0]!.headers["x-api-key"]).toBe("dnc_k");
  });

  it("reports a clean number as not listed", async () => {
    stubFetch(() => ({ json: { success: true, is_dnc: false, status: "NOT DNC" } }));
    await expect(createDncAdapter(realConfig()).lookup("+14045550100")).resolves.toEqual({ federal: false, state: false });
  });

  it("fails closed on an inconclusive answer rather than reporting the number clean", async () => {
    for (const json of [{ success: false }, { success: true }, {}, { success: true, is_dnc: "yes" }]) {
      stubFetch(() => ({ json }));
      await expect(createDncAdapter(realConfig()).lookup("+14045550100"))
        .rejects.toMatchObject({ code: "inconclusive_lookup", retryable: true });
    }
  });

  it("refuses a number this vendor cannot check", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await expect(createDncAdapter(realConfig()).lookup("+442075550100"))
      .rejects.toMatchObject({ code: "unsupported_number", retryable: false });
    expect(calls).toHaveLength(0);
    expect(toNanp10("+14045550100")).toBe("4045550100");
    expect(() => toNanp10("+14045550")).toThrow(/NANP/);
  });
});

describe("resend real adapter", () => {
  it("sends from MAIL_FROM with the idempotency header", async () => {
    const calls = stubFetch(() => ({ json: { id: "email_1" } }));
    const r = createResendAdapter(realConfig({ MAIL_FROM: "TM <booking@mail.tm.com>", RESEND_API_KEY: "re_k" }));
    expect(r.mode).toBe("real");
    await expect(r.sendEmail({ to: "a@b.co", subject: "Your appointment", html: "<p>hi</p>", template: "packet", idempotency_key: "booking:1" }))
      .resolves.toEqual({ id: "email_1" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["idempotency-key"]).toBe("booking:1");
    expect(calls[0]!.headers.authorization).toBe("Bearer re_k");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ from: "TM <booking@mail.tm.com>", to: "a@b.co", subject: "Your appointment", html: "<p>hi</p>" });
  });

  it("rejects an over-long idempotency key before sending", async () => {
    const calls = stubFetch(() => ({ json: { id: "x" } }));
    await expect(createResendAdapter(realConfig()).sendEmail({ to: "a@b.co", subject: "s", html: "<p/>", template: "t", idempotency_key: "k".repeat(257) }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("fails loudly when no id comes back", async () => {
    stubFetch(() => ({ json: {} }));
    await expect(createResendAdapter(realConfig()).sendEmail({ to: "a@b.co", subject: "s", html: "<p/>", template: "t", idempotency_key: "k" }))
      .rejects.toMatchObject({ code: "missing_email_id" });
  });
});
