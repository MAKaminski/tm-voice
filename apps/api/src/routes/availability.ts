import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { internalAuth } from "../middleware.js";

const q = z.object({
  service_address_id: z.string().uuid(),
  earliest: z.string().datetime().optional(),
  latest: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(5).default(5),
});

export function availabilityRoutes() {
  return new Hono<AppEnv>().use(internalAuth).get("/", async (c) => {
    const p = q.safeParse(c.req.query());
    if (!p.success) return c.json({ error: "invalid_query", issues: p.error.flatten() }, 400);
    const earliest = p.data.earliest ? new Date(p.data.earliest) : new Date();
    const latest = p.data.latest ? new Date(p.data.latest) : new Date(earliest.getTime() + 14 * 86_400_000);
    const slots = await c.get("availability").getSlots({ serviceAddressId: p.data.service_address_id, earliest, latest, limit: p.data.limit });
    return c.json({ slots });
  });
}
