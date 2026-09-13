import { Hono } from "hono";
import { healthcheckAll } from "@tm/adapters";
import type { AppEnv } from "../app.js";

export function healthRoutes() {
  return new Hono<AppEnv>().get("/", async (c) => {
    const { adapters, cfg } = c.get("deps");
    const vendors = await healthcheckAll(adapters);
    const ok = vendors.every((v) => v.ok);
    return c.json({ ok, dial_mode: cfg.DIAL_MODE, target_surface: cfg.COMPLIANCE_TARGET_SURFACE, dnc_scrub: cfg.DNC_SCRUB, auto_book: cfg.AUTO_BOOK, vendors }, ok ? 200 : 503);
  });
}
