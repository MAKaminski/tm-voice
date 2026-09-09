import type { Config } from "@tm/shared";
import { type Adapter, MockRecorder, notImplemented, useMock } from "../base.js";

export interface R2Adapter extends Adapter {
  putObject(key: string, body: Uint8Array | string, contentType: string): Promise<{ key: string }>;
  getSignedUrl(key: string, ttlSeconds: number): Promise<{ url: string; expires_at: string }>;
  deleteObject(key: string): Promise<void>;
}

export function createR2Adapter(cfg: Config): R2Adapter & { mock?: MockRecorder; store?: Map<string, Uint8Array | string> } {
  if (useMock(cfg, "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")) {
    const mock = new MockRecorder();
    const store = new Map<string, Uint8Array | string>();
    return {
      name: "r2", mode: "mock", mock, store,
      async healthcheck() { return { vendor: "r2", ok: true, mode: "mock" as const }; },
      async putObject(key, body) { mock.record("putObject", key); store.set(key, body); return { key }; },
      async getSignedUrl(key, ttl) {
        mock.record("getSignedUrl", key, ttl);
        return { url: `https://mock-r2.local/${key}?sig=mock`, expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
      },
      async deleteObject(key) { mock.record("deleteObject", key); store.delete(key); },
    };
  }
  return {
    name: "r2", mode: "real",
    async healthcheck() { return { vendor: "r2", ok: false, mode: "real", detail: "S3-compatible client lands in Phase 3" }; },
    async putObject() { return notImplemented("r2", "putObject"); },
    async getSignedUrl() { return notImplemented("r2", "getSignedUrl"); },
    async deleteObject() { return notImplemented("r2", "deleteObject"); },
  };
}
