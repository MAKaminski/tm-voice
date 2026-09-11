import { afterEach, describe, expect, it, vi } from "vitest";
import { isRetryableStatus, request } from "../src/index.js";
import { stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("builds the query string and merges headers", async () => {
    const calls = stubFetch(() => ({ json: { ok: true } }));
    await request({ vendor: "telnyx", url: "https://api.example.com/v2/thing", query: { type: "carrier", skip: undefined, n: 3 }, headers: { authorization: "Bearer k" } });
    expect(calls[0]!.url).toBe("https://api.example.com/v2/thing?type=carrier&n=3");
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    expect(calls[0]!.headers.accept).toBe("application/json");
  });

  it("JSON-encodes a body and sets content-type", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await request({ vendor: "vapi", method: "POST", url: "https://api.example.com/calls", body: { to: "+14045550100" } });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ to: "+14045550100" });
  });

  it("maps 4xx to a non-retryable AdapterError carrying the body", async () => {
    stubFetch(() => ({ status: 422, text: "bad number" }));
    await expect(request({ vendor: "telnyx", url: "https://api.example.com/x" })).rejects.toMatchObject({
      vendor: "telnyx", code: "http_422", retryable: false, raw: "bad number",
    });
  });

  it("retries 429 and succeeds on a later attempt", async () => {
    let n = 0;
    stubFetch(() => (++n < 3 ? { status: 429, text: "slow down" } : { json: { data: "ok" } }));
    await expect(request({ vendor: "hcp", url: "https://api.example.com/x", retry: { attempts: 4, baseMs: 1, maxMs: 2 } }))
      .resolves.toEqual({ data: "ok" });
    expect(n).toBe(3);
  });

  it("retries 5xx and reports the status after the last attempt", async () => {
    let n = 0;
    stubFetch(() => { n++; return { status: 503, text: "down" }; });
    await expect(request({ vendor: "hcp", url: "https://api.example.com/x", retry: { attempts: 2, baseMs: 1, maxMs: 2 } }))
      .rejects.toMatchObject({ code: "http_503", retryable: true });
    expect(n).toBe(2);
  });

  it("treats a transport failure as retryable", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => { n++; throw new Error("ECONNRESET"); });
    await expect(request({ vendor: "r2", url: "https://api.example.com/x", retry: { attempts: 2, baseMs: 1, maxMs: 2 } }))
      .rejects.toMatchObject({ code: "network_error", retryable: true });
    expect(n).toBe(2);
  });

  it("rejects a non-JSON success body without retrying", async () => {
    let n = 0;
    stubFetch(() => { n++; return { text: "<html>nope</html>" }; });
    await expect(request({ vendor: "apollo", url: "https://api.example.com/x", retry: { attempts: 3, baseMs: 1 } }))
      .rejects.toMatchObject({ code: "invalid_response", retryable: false });
    expect(n).toBe(1);
  });

  it("returns undefined for an empty body and for expect:void", async () => {
    stubFetch(() => ({ text: "" }));
    await expect(request({ vendor: "graph", url: "https://api.example.com/x" })).resolves.toBeUndefined();
    stubFetch(() => ({ json: { ignored: true } }));
    await expect(request({ vendor: "graph", url: "https://api.example.com/x", expect: "void" })).resolves.toBeUndefined();
  });

  it("classifies statuses", () => {
    expect([408, 425, 429, 500, 503].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 409, 422].some(isRetryableStatus)).toBe(false);
  });
});
