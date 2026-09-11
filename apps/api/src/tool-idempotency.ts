import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { logger } from "@tm/shared";

/** A tool call is the same call when the Vapi call id, tool name and arguments all match. */
export const toolIdempotencyKey = (callId: string, tool: string, args: unknown) =>
  `tool:${callId}:${tool}:${createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex").slice(0, 16)}`;

/** Long enough to cover a retried webhook or a repeated tool call inside one conversation. */
export const TOOL_RESULT_TTL_SEC = 24 * 3_600;
const MAX_LOCAL_ENTRIES = 1_000;

/**
 * Remembers what a tool already answered, so a Vapi retry gets the first result rather than
 * booking twice. Redis-backed because the api runs more than one replica and the previous
 * in-process Map made correctness depend on which replica happened to receive the retry — it also
 * grew without bound. The Map survives only as a single-process fallback for local dev and
 * dry_run, where there may be no Redis at all; it is bounded and its limits are why it is not the
 * production path.
 */
export class ToolIdempotency {
  private local = new Map<string, string>();
  constructor(private redis?: Redis) {}

  async get(key: string): Promise<unknown | undefined> {
    if (this.redis) {
      const hit = await this.redis.get(key).catch((e: unknown) => { logger.warn({ e, key }, "tool idempotency read failed"); return null; });
      return hit === null ? undefined : (JSON.parse(hit) as unknown);
    }
    const hit = this.local.get(key);
    return hit === undefined ? undefined : (JSON.parse(hit) as unknown);
  }

  async set(key: string, value: unknown): Promise<void> {
    const payload = JSON.stringify(value);
    if (this.redis) {
      await this.redis.set(key, payload, "EX", TOOL_RESULT_TTL_SEC)
        .catch((e: unknown) => logger.warn({ e, key }, "tool idempotency write failed"));
      return;
    }
    if (this.local.size >= MAX_LOCAL_ENTRIES) {
      const oldest = this.local.keys().next().value;
      if (oldest !== undefined) this.local.delete(oldest);
    }
    this.local.set(key, payload);
  }
}
