import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.js";

/** Bearer INTERNAL_API_TOKEN for console → api calls. Public routes (/health, /tools, /webhooks, /book/:token) skip it. */
export const internalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== c.get("deps").cfg.INTERNAL_API_TOKEN) return c.json({ error: "unauthorized" }, 401);
  await next();
};

/** Vapi tool-call / end-of-call webhook signature. Reads the raw body once and stashes it. */
export const vapiAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = await c.req.text();
  const ok = c.get("deps").adapters.vapi.verifyWebhook({ secret: c.req.header("x-vapi-secret"), signature: c.req.header("x-vapi-signature") }, raw);
  if (!ok) return c.json({ error: "bad_signature" }, 401);
  c.set("rawBody" as never, raw as never);
  await next();
};
