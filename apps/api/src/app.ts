import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import type { Redis } from "ioredis";
import type { Adapters } from "@tm/adapters";
import type { AnyDb } from "@tm/db";
import type { Config } from "@tm/shared";
import { AvailabilityService } from "./availability/index.js";
import type { Producer } from "./queue.js";
import { ToolIdempotency } from "./tool-idempotency.js";
import { availabilityRoutes } from "./routes/availability.js";
import { bookingRoutes } from "./routes/bookings.js";
import { healthRoutes } from "./routes/health.js";
import { testCallRoutes } from "./routes/test-calls.js";
import { toolRoutes } from "./routes/tools.js";
import { webhookRoutes } from "./routes/webhooks.js";

export interface AppDeps {
  cfg: Config;
  db: AnyDb;
  adapters: Adapters;
  producer: Producer;
  redis?: Redis;
}
export type AppEnv = { Variables: { deps: AppDeps; availability: AvailabilityService; toolIdem: ToolIdempotency } };

export function createApp(deps: AppDeps) {
  const availability = new AvailabilityService(deps.db, deps.redis);
  const toolIdem = new ToolIdempotency(deps.redis);
  const app = new Hono<AppEnv>();
  if (deps.cfg.NODE_ENV !== "test") app.use(honoLogger());
  app.use(async (c, next) => { c.set("deps", deps); c.set("availability", availability); c.set("toolIdem", toolIdem); await next(); });

  app.route("/health", healthRoutes());
  app.route("/availability", availabilityRoutes());
  app.route("/", bookingRoutes());
  app.route("/tools", toolRoutes());
  app.route("/", testCallRoutes());
  app.route("/webhooks", webhookRoutes());
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => { console.error(err); return c.json({ error: "internal", message: err.message }, 500); });
  return app;
}
