import type { QueueName } from "@tm/shared";
import type { Processor } from "./context.js";
import { availabilityInvalidate, availabilityMaterialize } from "./processors/availability.js";
import { apolloSyncCampaign, dialRequeue } from "./processors/campaign.js";
import { dialClaim, dialTick } from "./processors/dial.js";
import { graphCreateEvent, hcpCreateJob, resendSendPacket } from "./processors/fulfillment.js";
import { retentionSweep } from "./processors/retention.js";
import { stub } from "./processors/stubs.js";

type AnyProcessor = Processor<never>;
const p = (x: Processor<never> | Processor) => x as AnyProcessor;

/** queue → job name → processor. One place. */
export const REGISTRY: Record<QueueName, Record<string, AnyProcessor>> = {
  dial: { claim: p(dialClaim as Processor), tick: p(dialTick), requeue: p(dialRequeue as Processor) },
  postcall: { process: p(stub("postcall", 5)) },
  hcp: { createJob: p(hcpCreateJob) },
  graph: { createEvent: p(graphCreateEvent) },
  resend: { sendPacket: p(resendSendPacket) },
  apollo: { logCall: p(stub("apollo", 5)), syncCampaign: p(apolloSyncCampaign as Processor) },
  availability: { materialize: p(availabilityMaterialize), invalidate: p(availabilityInvalidate) },
  retention: { sweep: p(retentionSweep) },
};

/** Repeatable schedules registered at boot. */
export const SCHEDULES = [
  { queue: "availability" as const, name: "materialize", every: 15 * 60_000 },
  { queue: "retention" as const, name: "sweep", every: 24 * 3_600_000 },
  { queue: "dial" as const, name: "tick", every: 60_000 },
  // Apollo's contact search costs no credits, so an hourly pull keeps the queue fed cheaply.
  { queue: "apollo" as const, name: "syncCampaign", every: 60 * 60_000 },
  { queue: "dial" as const, name: "requeue", every: 30 * 60_000 },
];
