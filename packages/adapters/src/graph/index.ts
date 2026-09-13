import { constants, createHash, createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";
import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, request, useMock, validate } from "../base.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

export const createEventInput = z.object({
  subject: z.string(),
  body_html: z.string(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  timezone: z.string(),
  location: z.string(),
  attendees: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).min(1),
  /** Graph `transactionId` — makes createEvent idempotent. Graph caps it at 256 chars. */
  transaction_id: z.string().min(1).max(256),
});
export type CreateEventInput = z.infer<typeof createEventInput>;

export interface GraphAdapter extends Adapter {
  createEvent(input: CreateEventInput): Promise<{ id: string }>;
  getRsvp(eventId: string): Promise<{ email: string; status: string }[]>;
}

const PEM_BLOCK = (pem: string, label: string) =>
  new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`).exec(pem)?.[0];

/**
 * Entra certificate credentials need the certificate's SHA-256 thumbprint (`x5t#S256`) alongside
 * a signature from its private key, so MS_CLIENT_CERT_PEM must carry both blocks. Railway
 * variables cannot hold real newlines, so an escaped `\n` form is accepted too.
 */
export function parseCertPem(pem: string): { privateKey: ReturnType<typeof createPrivateKey>; x5tS256: string } {
  const normalized = pem.includes("-----BEGIN") ? pem.replace(/\\n/g, "\n") : pem;
  const cert = PEM_BLOCK(normalized, "CERTIFICATE");
  const key = PEM_BLOCK(normalized, "PRIVATE KEY") ?? PEM_BLOCK(normalized, "RSA PRIVATE KEY");
  if (!cert || !key) {
    throw new AdapterError({
      vendor: "graph", code: "invalid_cert_pem", retryable: false,
      message: "MS_CLIENT_CERT_PEM must contain both a CERTIFICATE and a PRIVATE KEY block",
    });
  }
  const der = Buffer.from(cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  return { privateKey: createPrivateKey(key), x5tS256: createHash("sha256").update(der).digest("base64url") };
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

/**
 * Builds the `private_key_jwt` client assertion Entra expects: PS256 (RSA-PSS + SHA-256),
 * `x5t#S256` in the header, and iss/sub both the client id.
 */
export function buildClientAssertion(cfg: { tenantId: string; clientId: string; certPem: string }, now = Date.now()): string {
  const { privateKey, x5tS256 } = parseCertPem(cfg.certPem);
  const iat = Math.floor(now / 1000);
  const header = b64url({ alg: "PS256", typ: "JWT", "x5t#S256": x5tS256 });
  const payload = b64url({
    aud: `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    iss: cfg.clientId, sub: cfg.clientId, jti: randomUUID(),
    nbf: iat, iat, exp: iat + 300,
  });
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${payload}`, "utf8"), {
    key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
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

  const mailbox = encodeURIComponent(cfg.MS_BOOKING_MAILBOX!);
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    // Re-use until a minute before expiry; every Graph call would otherwise mint an assertion.
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const assertion = buildClientAssertion({ tenantId: cfg.MS_TENANT_ID!, clientId: cfg.MS_CLIENT_ID!, certPem: cfg.MS_CLIENT_CERT_PEM! });
    const form = new URLSearchParams({
      client_id: cfg.MS_CLIENT_ID!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
    const res = await request<{ access_token?: string; expires_in?: number }>({
      vendor: "graph", method: "POST",
      url: `https://login.microsoftonline.com/${encodeURIComponent(cfg.MS_TENANT_ID!)}/oauth2/v2.0/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      rawBody: form.toString(),
    });
    if (!res.access_token) throw new AdapterError({ vendor: "graph", code: "token_request_failed", retryable: true, raw: res });
    token = { value: res.access_token, expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  const authed = async () => ({ authorization: `Bearer ${await accessToken()}` });

  return {
    name: "graph", mode: "real",
    async healthcheck() {
      try {
        // Probe the booking calendar, the only thing this app may touch: GET /users/{id} needs directory read (User.Read.All),
        // which the app is deliberately not granted, so it answered 403 while calendar writes worked.
        await request({ vendor: "graph", url: `${GRAPH}/users/${mailbox}/calendar`, query: { $select: "id" }, headers: await authed(), retry: { attempts: 1 } });
        return { vendor: "graph", ok: true, mode: "real" };
      } catch (e) {
        return { vendor: "graph", ok: false, mode: "real", detail: e instanceof Error ? e.message : "graph unreachable" };
      }
    },
    async createEvent(input) {
      const v = validate("graph", createEventInput, input);
      const res = await request<{ id?: string }>({
        vendor: "graph", method: "POST", url: `${GRAPH}/users/${mailbox}/events`, headers: await authed(),
        body: {
          subject: v.subject,
          body: { contentType: "HTML", content: v.body_html },
          // Graph wants wall-clock plus a zone; the input carries UTC instants, so the zone is UTC
          // and `timezone` is what the invite displays in.
          start: { dateTime: v.start, timeZone: "UTC" },
          end: { dateTime: v.end, timeZone: "UTC" },
          originalStartTimeZone: v.timezone,
          location: { displayName: v.location },
          attendees: v.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: "required" })),
          // Graph rejects a repeated transactionId, so a retried job cannot double-book.
          transactionId: v.transaction_id,
        },
      });
      if (!res.id) throw new AdapterError({ vendor: "graph", code: "missing_event_id", retryable: false, raw: res });
      return { id: res.id };
    },
    async getRsvp(eventId) {
      const res = await request<{ attendees?: { emailAddress?: { address?: string }; status?: { response?: string } }[] }>({
        vendor: "graph", url: `${GRAPH}/users/${mailbox}/events/${encodeURIComponent(eventId)}`,
        query: { $select: "attendees" }, headers: await authed(),
      });
      return (res.attendees ?? [])
        .filter((a) => a.emailAddress?.address)
        .map((a) => ({ email: a.emailAddress!.address!, status: a.status?.response ?? "none" }));
    },
  };
}
