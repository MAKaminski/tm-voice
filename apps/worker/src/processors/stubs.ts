import { logger } from "@tm/shared";
import type { Processor } from "../context.js";

/** Registered now so the queue contract is fixed; bodies land in Phase 3 (adapters) / 4 (fulfillment) / 5 (post-call). */
export const stub = (queue: string, phase: number): Processor => async (_ctx, payload) => {
  logger.info({ queue, entity_id: payload.entity_id, idempotency_key: payload.idempotency_key, phase }, "stub processor: acknowledged");
  return { stub: true, phase };
};
