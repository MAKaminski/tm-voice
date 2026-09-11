import { afterEach, describe, expect, it, vi } from "vitest";
import { createApolloAdapter } from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const logInput = {
  contact_id: "c_1", to_number: "+14045550100", from_number: "+14045550000",
  status: "completed", start_time: "2026-09-11T14:00:00.000Z", end_time: "2026-09-11T14:02:30.000Z",
  duration: 150, phone_call_outcome_id: "o_1", note: "Booked. Recording: https://r2/signed",
};

describe("apollo real adapter", () => {
  it("logs a call as query parameters on POST /phone_calls", async () => {
    const calls = stubFetch(() => ({ json: { phone_call: { id: "pc_1" } } }));
    const a = createApolloAdapter(realConfig({ APOLLO_API_KEY: "ap_k" }));
    expect(a.mode).toBe("real");
    await expect(a.logPhoneCall(logInput, "postcall:1")).resolves.toEqual({ id: "pc_1" });
    const u = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe("POST");
    expect(u.origin + u.pathname).toBe("https://api.apollo.io/api/v1/phone_calls");
    expect(calls[0]!.headers["x-api-key"]).toBe("ap_k");
    expect(u.searchParams.get("logged")).toBe("true");
    expect(u.searchParams.get("to_number")).toBe("+14045550100");
    expect(u.searchParams.get("duration")).toBe("150");
    expect(u.searchParams.get("note")).toBe(logInput.note);
  });

  it("omits absent optional parameters rather than sending empty ones", async () => {
    const calls = stubFetch(() => ({ json: { phone_call: { id: "pc_1" } } }));
    const { contact_id: _drop, phone_call_outcome_id: _drop2, ...rest } = logInput;
    await createApolloAdapter(realConfig()).logPhoneCall(rest, "k");
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.has("contact_id")).toBe(false);
    expect(u.searchParams.has("phone_call_outcome_id")).toBe(false);
  });

  it("fails loudly when no phone_call id comes back", async () => {
    stubFetch(() => ({ json: { phone_call: {} } }));
    await expect(createApolloAdapter(realConfig()).logPhoneCall(logInput, "k"))
      .rejects.toMatchObject({ code: "missing_phone_call_id" });
  });

  it("rejects a non-E.164 number before sending", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await expect(createApolloAdapter(realConfig()).logPhoneCall({ ...logInput, to_number: "4045550100" }, "k"))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("patches the account stage", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await createApolloAdapter(realConfig()).updateAccountStage("acct_1", "stage_7");
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.apollo.io/api/v1/accounts/acct_1?account_stage_id=stage_7");
  });

  it("pages through a saved list and flattens phone numbers", async () => {
    const page = (n: number, total: number) => ({
      json: {
        contacts: [{ id: `c_${n}`, first_name: "A", last_name: "B", email: "a@b.co", organization_id: "org_1", phone_numbers: [{ sanitized_number: `+1404555010${n}`, raw_number: "(404) 555-0100" }] }],
        pagination: { page: n, total_pages: total },
      },
    });
    let n = 0;
    const calls = stubFetch(() => page(++n, 3));
    const res = await createApolloAdapter(realConfig()).listSavedSearchContacts("label_1");
    expect(res).toHaveLength(3);
    expect(res[0]).toEqual({ id: "c_1", phone: "+14045550101", first_name: "A", last_name: "B", email: "a@b.co", organization_id: "org_1" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ contact_label_ids: ["label_1"], page: 1, per_page: 100 });
    expect(JSON.parse(calls[2]!.body!).page).toBe(3);
  });

  it("stops on an empty page and skips contacts with no id", async () => {
    const calls = stubFetch(() => ({ json: { contacts: [], pagination: { total_pages: 9 } } }));
    await expect(createApolloAdapter(realConfig()).listSavedSearchContacts("label_1")).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    stubFetch(() => ({ json: { contacts: [{ first_name: "no id" }], pagination: { total_pages: 1 } } }));
    await expect(createApolloAdapter(realConfig()).listSavedSearchContacts("label_1")).resolves.toEqual([]);
  });

  it("falls back to the raw number when no sanitized number is present", async () => {
    stubFetch(() => ({ json: { contacts: [{ id: "c", phone_numbers: [{ raw_number: "(404) 555-0100" }] }], pagination: { total_pages: 1 } } }));
    await expect(createApolloAdapter(realConfig()).listSavedSearchContacts("l")).resolves.toMatchObject([{ phone: "(404) 555-0100" }]);
  });
});
