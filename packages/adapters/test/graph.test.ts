import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClientAssertion, createGraphAdapter, parseCertPem } from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

/**
 * A cert + key in one PEM, the shape MS_CLIENT_CERT_PEM is documented to hold. The key pair is
 * generated per run so no private key is ever committed. The CERTIFICATE block stands in for the
 * DER Entra was given: parseCertPem only hashes those bytes to build x5t#S256, and Entra likewise
 * matches the thumbprint of whatever certificate was uploaded, so arbitrary DER exercises the
 * same path without needing an X.509 toolchain in CI.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = randomBytes(96);
const pem = [
  "-----BEGIN CERTIFICATE-----",
  der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd(),
  "-----END CERTIFICATE-----",
  privateKey.export({ format: "pem", type: "pkcs8" }).toString().trimEnd(),
].join("\n");
const graphCfg = (over: Record<string, string> = {}) =>
  realConfig({ MS_CLIENT_CERT_PEM: pem, MS_TENANT_ID: "tenant-1", MS_CLIENT_ID: "client-1", MS_BOOKING_MAILBOX: "booking@tm.com", ...over });

const event = {
  subject: "Drain inspection", body_html: "<p>details</p>",
  start: "2026-09-20T14:00:00.000Z", end: "2026-09-20T16:00:00.000Z",
  timezone: "America/New_York", location: "123 Peachtree St",
  attendees: [{ email: "tech@tm.com", name: "Pedro" }, { email: "cust@x.co" }],
  transaction_id: "booking:abc",
};

const tokenThen = (then: (url: string) => { status?: number; json?: unknown }) =>
  stubFetch((c) => (c.url.includes("/oauth2/v2.0/token") ? { json: { access_token: "tok_1", expires_in: 3600 } } : then(c.url)));

describe("graph certificate credentials", () => {
  it("derives x5t#S256 from the certificate DER, not the key", () => {
    const { x5tS256 } = parseCertPem(pem);
    expect(x5tS256).toBe(createHash("sha256").update(der).digest("base64url"));
  });

  it("accepts a PEM whose newlines are backslash-escaped", () => {
    expect(parseCertPem(pem.replace(/\n/g, "\\n")).x5tS256).toBe(parseCertPem(pem).x5tS256);
  });

  it("rejects a PEM missing either block", () => {
    expect(() => parseCertPem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")).toThrow(/PRIVATE KEY/);
    expect(() => parseCertPem("nonsense")).toThrow(/CERTIFICATE/);
  });

  it("builds a PS256 assertion with the claims Entra requires", () => {
    const jwt = buildClientAssertion({ tenantId: "tenant-1", clientId: "client-1", certPem: pem }, 1_700_000_000_000);
    const [h, p, s] = jwt.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString());
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(header).toMatchObject({ alg: "PS256", typ: "JWT" });
    expect(header["x5t#S256"]).toBe(parseCertPem(pem).x5tS256);
    expect(claims.aud).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(claims.iss).toBe("client-1");
    expect(claims.sub).toBe("client-1");
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.exp - claims.nbf).toBe(300);
    // The signature must verify as RSA-PSS over header.payload with the matching public key.
    const ok = createVerify("sha256")
      .update(`${h}.${p}`)
      .verify({ key: publicKey, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: -1 /* RSA_PSS_SALTLEN_DIGEST */ }, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("graph real adapter", () => {
  it("exchanges the assertion for a token with the documented form body", async () => {
    const calls = tokenThen(() => ({ json: { id: "evt_1" } }));
    const g = createGraphAdapter(graphCfg());
    expect(g.mode).toBe("real");
    await g.createEvent(event);
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    const form = new URLSearchParams(calls[0]!.body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(form.get("client_assertion")!.split(".")).toHaveLength(3);
  });

  it("creates the event on the booking mailbox with transactionId for idempotency", async () => {
    const calls = tokenThen(() => ({ json: { id: "evt_1" } }));
    await expect(createGraphAdapter(graphCfg()).createEvent(event)).resolves.toEqual({ id: "evt_1" });
    expect(calls[1]!.url).toBe("https://graph.microsoft.com/v1.0/users/booking%40tm.com/events");
    expect(calls[1]!.headers.authorization).toBe("Bearer tok_1");
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toMatchObject({
      subject: "Drain inspection",
      body: { contentType: "HTML", content: "<p>details</p>" },
      start: { dateTime: "2026-09-20T14:00:00.000Z", timeZone: "UTC" },
      location: { displayName: "123 Peachtree St" },
      transactionId: "booking:abc",
    });
    expect(body.attendees).toEqual([
      { emailAddress: { address: "tech@tm.com", name: "Pedro" }, type: "required" },
      { emailAddress: { address: "cust@x.co" }, type: "required" },
    ]);
  });

  it("caches the token across calls", async () => {
    const calls = tokenThen(() => ({ json: { id: "evt_1", attendees: [] } }));
    const g = createGraphAdapter(graphCfg());
    await g.createEvent(event);
    await g.getRsvp("evt_1");
    expect(calls.filter((c) => c.url.includes("/oauth2/"))).toHaveLength(1);
  });

  it("reads attendee RSVP status and defaults a missing response to none", async () => {
    tokenThen(() => ({ json: { attendees: [
      { emailAddress: { address: "a@x.co" }, status: { response: "accepted" } },
      { emailAddress: { address: "b@x.co" } },
      { status: { response: "declined" } },
    ] } }));
    await expect(createGraphAdapter(graphCfg()).getRsvp("evt_1")).resolves.toEqual([
      { email: "a@x.co", status: "accepted" },
      { email: "b@x.co", status: "none" },
    ]);
  });

  it("rejects an over-long transaction id and a missing event id", async () => {
    tokenThen(() => ({ json: { id: "evt" } }));
    await expect(createGraphAdapter(graphCfg()).createEvent({ ...event, transaction_id: "k".repeat(257) }))
      .rejects.toMatchObject({ code: "invalid_input" });
    tokenThen(() => ({ json: {} }));
    await expect(createGraphAdapter(graphCfg()).createEvent(event)).rejects.toMatchObject({ code: "missing_event_id" });
  });

  it("treats a token response with no access_token as retryable", async () => {
    stubFetch(() => ({ json: { error: "invalid_client" } }));
    await expect(createGraphAdapter(graphCfg()).createEvent(event))
      .rejects.toMatchObject({ code: "token_request_failed", retryable: true });
  });
});
