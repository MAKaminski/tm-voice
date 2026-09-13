/** pnpm replay <queue> <job_id> — moves a dead-letter job back onto its origin queue. */
import { Queue } from "bullmq";
import { createRedis } from "@tm/api";
import { DLQ_NAME, QUEUES, type QueueName, bullJobId, getConfig } from "@tm/shared";

const [queueName, jobId] = process.argv.slice(2);
if (!queueName || !jobId || !QUEUES.includes(queueName as QueueName)) {
  console.error(`usage: pnpm replay <${QUEUES.join("|")}> <job_id>`); process.exit(2);
}
const cfg = getConfig();
if (!cfg.REDIS_URL) throw new Error("replay requires REDIS_URL");
const connection = createRedis(cfg.REDIS_URL);
const dlq = new Queue(DLQ_NAME, { connection });
const dead = (await dlq.getJob(bullJobId(`dead:${queueName}:${jobId}`))) ?? (await dlq.getJob(bullJobId(jobId)));
if (!dead) { console.error(`no dead job for ${queueName}/${jobId}`); process.exit(1); }
const { _origin, ...data } = dead.data as { _origin: { name: string } } & Record<string, unknown>;
const target = new Queue(queueName, { connection });
const j = await target.add(_origin.name, data, { jobId: bullJobId(`${String(data.idempotency_key)}:replay:${Date.now()}`) });
await dead.remove();
console.log(`replayed ${queueName}.${_origin.name} as ${j.id}`);
await connection.quit();
