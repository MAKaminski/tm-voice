import type { QueueName } from "@tm/shared";
import type { Processor } from "./context.js";
import { availabilityInvalidate, availabilityMaterialize } from "./processors/availability.js";
import { dialClaim, dialTick } from "./processors/dial.js";
import { retentionSweep } from "./processors/retention.js";
import { stub } from "./processors/stubs.js";

type AnyProcessor = Processor<never>;
const p = (x: Processor<never> | Processor) => x as AnyProcessor;

/** queue → job name → processor. One place. */
export const REGISTRY: Record<QueueName, Record<string, AnyProcessor>> = {
  dial: { claim: p(dialClaim as Processor), tick: p(dialTick) },
  postcall: { process: p(stub("postcall", 5)) },
  hcp: { createJob: p(stub("hcp", 4)) },
  graph: { createEvent: p(stub("graph", 4)) },
  resend: { sendPacket: p(stub("resend", 4)) },
  apollo: { logCall: p(stub("apollo", 5)) },
  availability: { materialize: p(availabilityMaterialize), invalidate: p(availabilityInvalidate) },
  retention: { sweep: p(retentionSweep) },
};

/** Repeatable schedules registered at boot. */
export const SCHEDULES = [
  { queue: "availability" as const, name: "materialize", every: 15 * 60_000 },
  { queue: "retention" as const, name: "sweep", every: 24 * 3_600_000 },
  { queue: "dial" as const, name: "tick", every: 60_000 },
];
