import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { AdapterError, type Config } from "@tm/shared";
import { type Adapter, MockRecorder, useMock } from "../base.js";

export interface R2Adapter extends Adapter {
  putObject(key: string, body: Uint8Array | string, contentType: string): Promise<{ key: string }>;
  /**
   * Read an object back into memory. Added for meeting transcription, which has to hand the bytes
   * to an STT provider rather than a URL — not every provider fetches, and a presigned URL would
   * put the recording on the public internet for the length of its TTL.
   */
  getObject(key: string): Promise<Uint8Array>;
  getSignedUrl(key: string, ttlSeconds: number): Promise<{ url: string; expires_at: string }>;
  deleteObject(key: string): Promise<void>;
}

/** R2's S3 endpoint. It ignores regions, but the SigV4 signer requires one, and R2 expects "auto". */
export const r2Endpoint = (accountId: string) => `https://${accountId}.r2.cloudflarestorage.com`;

/** R2 presigned URLs are capped at 7 days by SigV4. */
export const MAX_SIGNED_TTL_SEC = 7 * 24 * 3_600;

function wrap(vendor: "r2", op: string, e: unknown): never {
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  throw new AdapterError({
    vendor, code: status ? `http_${status}` : "s3_error",
    // 5xx and throttling are worth another attempt; a 404 or a signature problem is not.
    retryable: status === undefined ? false : status === 408 || status === 429 || status >= 500,
    message: `r2.${op} failed${status ? ` with ${status}` : ""}`,
    raw: e instanceof Error ? e.message : e,
  });
}

export function createR2Adapter(cfg: Config): R2Adapter & { mock?: MockRecorder; store?: Map<string, Uint8Array | string> } {
  if (useMock(cfg, "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")) {
    const mock = new MockRecorder();
    const store = new Map<string, Uint8Array | string>();
    return {
      name: "r2", mode: "mock", mock, store,
      async healthcheck() { return { vendor: "r2", ok: true, mode: "mock" as const }; },
      async putObject(key, body) { mock.record("putObject", key); store.set(key, body); return { key }; },
      async getObject(key) {
        mock.record("getObject", key);
        const v = store.get(key);
        if (v === undefined) throw new AdapterError({ vendor: "r2", code: "http_404", retryable: false, raw: { key } });
        return typeof v === "string" ? new TextEncoder().encode(v) : v;
      },
      async getSignedUrl(key, ttl) {
        mock.record("getSignedUrl", key, ttl);
        return { url: `https://mock-r2.local/${key}?sig=mock`, expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
      },
      async deleteObject(key) { mock.record("deleteObject", key); store.delete(key); },
    };
  }

  const Bucket = cfg.R2_BUCKET!;
  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(cfg.R2_ACCOUNT_ID!),
    credentials: { accessKeyId: cfg.R2_ACCESS_KEY_ID!, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY! },
    // Pin the fetch handler instead of the default node-http one: every other adapter goes through
    // fetch, and the SDK's own handler cannot be observed or stubbed alongside them.
    requestHandler: new FetchHttpHandler(),
  });

  return {
    name: "r2", mode: "real",
    async healthcheck() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        return { vendor: "r2", ok: true, mode: "real" };
      } catch (e) {
        return { vendor: "r2", ok: false, mode: "real", detail: e instanceof Error ? e.message : "bucket unreachable" };
      }
    },
    async putObject(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
        return { key };
      } catch (e) { wrap("r2", "putObject", e); }
    },
    async getObject(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) throw new AdapterError({ vendor: "r2", code: "empty_body", retryable: false, raw: { key } });
        return new Uint8Array(await res.Body.transformToByteArray());
      } catch (e) {
        if (e instanceof AdapterError) throw e;
        wrap("r2", "getObject", e);
      }
    },
    async getSignedUrl(key, ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_SIGNED_TTL_SEC) {
        throw new AdapterError({ vendor: "r2", code: "invalid_ttl", retryable: false, message: `ttlSeconds must be 1..${MAX_SIGNED_TTL_SEC}` });
      }
      try {
        const url = await presign(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: ttlSeconds });
        return { url, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
      } catch (e) { wrap("r2", "getSignedUrl", e); }
    },
    async deleteObject(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (e) { wrap("r2", "deleteObject", e); }
    },
  };
}
