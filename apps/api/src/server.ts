import { serve } from "@hono/node-server";
import { createAdapters } from "@tm/adapters";
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
const app = createApp({ cfg, db, adapters, producer, redis });
serve({ fetch: app.fetch, port: cfg.PORT }, (info) => logger.info({ port: info.port, dial_mode: cfg.DIAL_MODE }, "api listening"));
