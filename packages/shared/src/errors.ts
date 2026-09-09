export type Vendor = "apollo" | "hcp" | "graph" | "resend" | "telnyx" | "vapi" | "r2" | "dnc";

export interface AdapterErrorShape {
  vendor: Vendor;
  code: string;
  retryable: boolean;
  raw?: unknown;
}

export class AdapterError extends Error implements AdapterErrorShape {
  vendor: Vendor;
  code: string;
  retryable: boolean;
  raw?: unknown;
  constructor(shape: AdapterErrorShape & { message?: string }) {
    super(shape.message ?? `${shape.vendor}: ${shape.code}`);
    this.name = "AdapterError";
    this.vendor = shape.vendor;
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.raw = shape.raw;
  }
}

export class GateBlockedError extends Error {
  constructor(public readonly gateResult: string, public readonly callTaskId: string) {
    super(`call_task ${callTaskId} blocked by gate: ${gateResult}`);
    this.name = "GateBlockedError";
  }
}
