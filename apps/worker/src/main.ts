import { Queue, Worker } from "bullmq";
import { createAdapters, mockedVendors } from "@tm/adapters";
import { createProducer, createRedis } from "@tm/api";
import { createDb } from "@tm/db";
import { DLQ_NAME, QUEUES, RETRY_POLICY, getConfig, jobEnvelopeSchema, logger } from "@tm/shared";
import type { Ctx } from "./context.js";
import { REGISTRY, SCHEDULES } from "./registry.js";

const cfg = getConfig();
if (!cfg.REDIS_URL) throw new Error("worker requires REDIS_URL (BullMQ). For dry runs without Redis, use the api's inline producer.");
const connection = createRedis(cfg.REDIS_URL);
const { db } = createDb(cfg.DATABASE_URL);
const adapters = createAdapters(cfg);
const ctx: Ctx = { cfg, db, adapters, producer: createProducer(cfg.REDIS_URL) };
// A vendor left on fixtures outside dry_run is a configuration gap, not a mode. Say so loudly.
if (cfg.DIAL_MODE !== "dry_run") {
  const mocked = mockedVendors(adapters);
  if (mocked.length) logger.warn({ dial_mode: cfg.DIAL_MODE, mocked }, "vendors still answering with mock fixtures outside dry_run");
}
const dlq = new Queue(DLQ_NAME, { connection });

const workers = QUEUES.map((q) => {
  const w = new Worker(q, async (job) => {
    const payload = jobEnvelopeSchema.passthrough().parse({ ...job.data, attempt: job.attemptsMade });
    const proc = REGISTRY[q][job.name];
    if (!proc) throw new Error(`no processor for ${q}.${job.name}`);
    return proc(ctx, payload as never);
  }, { connection, concurrency: q === "dial" ? 1 : 4 });
  w.on("failed", async (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? RETRY_POLICY.attempts);
    logger.error({ queue: q, job: job.name, id: job.id, attempt: job.attemptsMade, final, err: err.message }, "job failed");
    if (final) await dlq.add(`${q}.${job.name}`, { ...job.data, _origin: { queue: q, name: job.name, id: job.id, error: err.message } }, { jobId: `dead:${q}:${job.id}` });
  });
  return w;
});

for (const s of SCHEDULES) {
  const q = new Queue(s.queue, { connection });
  await q.upsertJobScheduler(`${s.queue}.${s.name}`, { every: s.every }, {
    name: s.name, data: { entity_id: "scheduler", idempotency_key: `${s.queue}.${s.name}`, attempt: 0, enqueued_at: new Date().toISOString() },
  });
}
logger.info({ queues: QUEUES, dial_mode: cfg.DIAL_MODE, schedules: SCHEDULES.map((s) => `${s.queue}.${s.name}`) }, "worker up");

const shutdown = async () => { await Promise.all(workers.map((w) => w.close())); await connection.quit(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
