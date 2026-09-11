import { serve } from "@hono/node-server";
import { createAdapters, mockedVendors } from "@tm/adapters";
import { createDb } from "@tm/db";
import { getConfig, logger } from "@tm/shared";
import { createApp } from "./app.js";
import { materialize } from "./availability/index.js";
import { createProducer, createRedis } from "./queue.js";

const cfg = getConfig();
const { db } = createDb(cfg.DATABASE_URL);
const adapters = createAdapters(cfg);
const redis = cfg.REDIS_URL ? createRedis(cfg.REDIS_URL) : undefined;
// Without Redis the only job the api itself emits (availability.materialize) runs inline.
const producer = createProducer(cfg.REDIS_URL, async (queue, name) => {
  if (queue === "availability" && name === "materialize") await materialize(db, adapters.hcp);
});
warnIfMocked(cfg, adapters);
const app = createApp({ cfg, db, adapters, producer, redis });
serve({ fetch: app.fetch, port: cfg.PORT }, (info) => logger.info({ port: info.port, dial_mode: cfg.DIAL_MODE }, "api listening"));

/** A vendor left on fixtures outside dry_run is a configuration gap, not a mode. Say so loudly. */
function warnIfMocked(c: typeof cfg, a: typeof adapters) {
  if (c.DIAL_MODE === "dry_run") return;
  const mocked = mockedVendors(a);
  if (mocked.length) logger.warn({ dial_mode: c.DIAL_MODE, mocked }, "vendors still answering with mock fixtures outside dry_run");
}
