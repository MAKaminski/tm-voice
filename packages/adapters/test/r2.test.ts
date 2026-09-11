import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SIGNED_TTL_SEC, createR2Adapter, r2Endpoint } from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const cfg = () => realConfig({ R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "AKIAX", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "tm-call-recordings" });

describe("r2 real adapter", () => {
  it("targets the account's R2 endpoint and bucket with a signed PUT", async () => {
    const calls = stubFetch(() => ({ status: 200, text: "" }));
    const r = createR2Adapter(cfg());
    expect(r.mode).toBe("real");
    await expect(r.putObject("recordings/2026/09/call-1.wav", new Uint8Array([1, 2, 3]), "audio/wav")).resolves.toEqual({ key: "recordings/2026/09/call-1.wav" });
    const c = calls[0]!;
    expect(c.method).toBe("PUT");
    // The SDK appends its own ?x-id=<Operation> marker, so compare the addressed object.
    const put = new URL(c.url);
    expect(put.origin + put.pathname).toBe("https://tm-call-recordings.acct123.r2.cloudflarestorage.com/recordings/2026/09/call-1.wav");
    // SigV4 must have run: an unsigned request would never reach R2.
    expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAX\//);
    expect(c.headers["content-type"]).toBe("audio/wav");
  });

  it("deletes with a signed DELETE", async () => {
    const calls = stubFetch(() => ({ status: 204, text: "" }));
    await createR2Adapter(cfg()).deleteObject("recordings/old.wav");
    expect(calls[0]!.method).toBe("DELETE");
    const del = new URL(calls[0]!.url);
    expect(del.origin + del.pathname).toBe("https://tm-call-recordings.acct123.r2.cloudflarestorage.com/recordings/old.wav");
  });

  it("presigns a GET without any network call and reports the expiry", async () => {
    const calls = stubFetch(() => ({ status: 200, text: "" }));
    const { url, expires_at } = await createR2Adapter(cfg()).getSignedUrl("recordings/call-1.wav", 900);
    expect(calls).toHaveLength(0);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://tm-call-recordings.acct123.r2.cloudflarestorage.com/recordings/call-1.wav");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
  });

  it("rejects a ttl the signer cannot produce", async () => {
    const r = createR2Adapter(cfg());
    for (const ttl of [0, -1, 1.5, MAX_SIGNED_TTL_SEC + 1]) {
      await expect(r.getSignedUrl("k", ttl)).rejects.toMatchObject({ code: "invalid_ttl", retryable: false });
    }
    await expect(r.getSignedUrl("k", MAX_SIGNED_TTL_SEC)).resolves.toBeDefined();
  });

  it("maps a 5xx to a retryable error and a 404 to a permanent one", async () => {
    stubFetch(() => ({ status: 503, text: "<Error><Code>SlowDown</Code></Error>" }));
    await expect(createR2Adapter(cfg()).putObject("k", "x", "text/plain")).rejects.toMatchObject({ vendor: "r2", retryable: true });
    stubFetch(() => ({ status: 404, text: "<Error><Code>NoSuchKey</Code></Error>" }));
    await expect(createR2Adapter(cfg()).deleteObject("k")).rejects.toMatchObject({ vendor: "r2", code: "http_404", retryable: false });
  });

  it("reports an unreachable bucket through healthcheck instead of throwing", async () => {
    stubFetch(() => ({ status: 403, text: "" }));
    await expect(createR2Adapter(cfg()).healthcheck()).resolves.toMatchObject({ vendor: "r2", ok: false, mode: "real" });
  });
});
