import type { Config } from "@tm/shared";
import { createApolloAdapter } from "./apollo/index.js";
import { createDncAdapter } from "./dnc/index.js";
import { createGraphAdapter } from "./graph/index.js";
import { createHcpAdapter } from "./hcp/index.js";
import { createR2Adapter } from "./r2/index.js";
import { createResendAdapter } from "./resend/index.js";
import { createTelnyxAdapter } from "./telnyx/index.js";
import { createVapiAdapter } from "./vapi/index.js";

export * from "./base.js";
export * from "./apollo/index.js";
export * from "./dnc/index.js";
export * from "./graph/index.js";
export * from "./hcp/index.js";
export * from "./r2/index.js";
export * from "./resend/index.js";
export * from "./telnyx/index.js";
export * from "./vapi/index.js";

export function createAdapters(cfg: Config) {
  return {
    apollo: createApolloAdapter(cfg),
    hcp: createHcpAdapter(cfg),
    graph: createGraphAdapter(cfg),
    resend: createResendAdapter(cfg),
    telnyx: createTelnyxAdapter(cfg),
    vapi: createVapiAdapter(cfg),
    r2: createR2Adapter(cfg),
    dnc: createDncAdapter(cfg),
  };
}
export type Adapters = ReturnType<typeof createAdapters>;

/**
 * Vendors still answering with fixtures. Outside dry_run only the dial-path keys are required, so
 * this is how a half-configured deploy stays visible instead of quietly serving mock availability.
 */
export function mockedVendors(adapters: Adapters): string[] {
  return Object.values(adapters).filter((a) => a.mode === "mock").map((a) => a.name);
}

export async function healthcheckAll(adapters: Adapters) {
  return Promise.all(Object.values(adapters).map((a) => a.healthcheck().catch((e: Error) => ({ vendor: a.name, ok: false, mode: a.mode, detail: e.message }))));
}
