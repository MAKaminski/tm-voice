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
/**
 * `::` rather than the default `0.0.0.0`, and it is why the console could not reach this service.
 *
 * Railway's private network (`<service>.railway.internal`) resolves to IPv6 only. Bound to
 * 0.0.0.0 the api answered the public edge proxy perfectly — `GET /health` 200 all day — while
 * every request from the console was refused before it left the container, so the api logged
 * nothing at all and the Calls tab read "Could not reach the api". `::` accepts both families,
 * so the public domain keeps working and private traffic starts to.
 */
serve({ fetch: app.fetch, port: cfg.PORT, hostname: "::" }, (info) => logger.info({ port: info.port, host: "::", dial_mode: cfg.DIAL_MODE }, "api listening"));

/** A vendor left on fixtures outside dry_run is a configuration gap, not a mode. Say so loudly. */
function warnIfMocked(c: typeof cfg, a: typeof adapters) {
  if (c.DIAL_MODE === "dry_run") return;
  // dnc is intentionally unused when the scrub is off, so it is not a gap worth listing twice.
  const mocked = mockedVendors(a).filter((v) => !(v === "dnc" && c.DNC_SCRUB === "off"));
  if (mocked.length) logger.warn({ dial_mode: c.DIAL_MODE, mocked }, "vendors still answering with mock fixtures outside dry_run");
  if (c.DNC_SCRUB === "off") logger.warn({ dial_mode: c.DIAL_MODE }, "DNC_SCRUB=off: numbers are dialed without a registry lookup; only hits already cached on the contact block");
}
