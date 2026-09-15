import { z } from "zod";

export const QUEUES = ["dial", "postcall", "hcp", "graph", "resend", "apollo", "availability", "retention", "vapi"] as const;
export type QueueName = (typeof QUEUES)[number];
export const DLQ_NAME = "dead";

export const jobEnvelopeSchema = z.object({
  entity_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  attempt: z.number().int().nonnegative().default(0),
  enqueued_at: z.string().datetime(),
});
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export function envelope(entityId: string, idempotencyKey: string): JobEnvelope {
  return { entity_id: entityId, idempotency_key: idempotencyKey, attempt: 0, enqueued_at: new Date().toISOString() };
}

/**
 * BullMQ rejects a custom job id containing ":" ("Custom Id cannot contain :"), but idempotency keys are
 * colon-joined and often end in an ISO timestamp. The payload keeps the key verbatim; only the BullMQ id is
 * escaped, reversibly ("%" first, then ":"), so two different keys can never map to the same job id.
 */
export function bullJobId(key: string): string {
  return key.replaceAll("%", "%25").replaceAll(":", "%3A");
}

/** One retry policy for every queue: 5 attempts, exponential 30s -> 16m. */
export const RETRY_POLICY = { attempts: 5, backoff: { type: "exponential" as const, delay: 30_000 } };
