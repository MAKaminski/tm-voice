/** Thin BullMQ producer. Every job carries the standard envelope (CLAUDE.md rule 2). Falls back to inline handlers without Redis. */
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { DLQ_NAME, type JobEnvelope, QUEUES, type QueueName, RETRY_POLICY, bullJobId, jobEnvelopeSchema, logger } from "@tm/shared";

export type JobPayload<T = Record<string, unknown>> = JobEnvelope & T;
export type InlineHandler = (queue: QueueName, name: string, payload: JobPayload) => Promise<void>;

export interface Producer {
  enqueue<T extends Record<string, unknown>>(queue: QueueName, name: string, payload: JobPayload<T>): Promise<{ id: string; inline: boolean }>;
  close(): Promise<void>;
}

export function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export function createProducer(redisUrl: string | undefined, inline?: InlineHandler): Producer {
  if (!redisUrl) {
    logger.warn("REDIS_URL absent: jobs run inline (dev/dry_run only)");
    return {
      async enqueue(queue, name, payload) {
        jobEnvelopeSchema.parse(payload);
        if (inline) await inline(queue, name, payload);
        else logger.info({ queue, name, payload }, "inline: no handler registered, job logged only");
        return { id: `inline:${payload.idempotency_key}`, inline: true };
      },
      async close() {},
    };
  }
  const connection = createRedis(redisUrl);
  const queues = new Map<string, Queue>();
  const get = (n: string) => { let q = queues.get(n); if (!q) { q = new Queue(n, { connection, defaultJobOptions: { ...RETRY_POLICY, removeOnComplete: 1000, removeOnFail: false } }); queues.set(n, q); } return q; };
  for (const q of [...QUEUES, DLQ_NAME]) get(q);
  return {
    async enqueue(queue, name, payload) {
      jobEnvelopeSchema.parse(payload);
      const job = await get(queue).add(name, payload, { jobId: bullJobId(payload.idempotency_key) });
      return { id: job.id ?? payload.idempotency_key, inline: false };
    },
    async close() { await Promise.all([...queues.values()].map((q) => q.close())); await connection.quit(); },
  };
}
