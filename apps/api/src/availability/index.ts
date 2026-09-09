import type { Redis } from "ioredis";
import type { AnyDb } from "@tm/db";
import { logger } from "@tm/shared";
import { type Slot, type SlotQuery, computeSlots } from "./slots.js";

export * from "./materialize.js";
export * from "./slots.js";

export const SLOT_TTL_SEC = 15 * 60;
const key = (addr: string, earliest: Date) => `slots:${addr}:${earliest.toISOString().slice(0, 10)}`;

/** Redis-cached wrapper. Without Redis (local dev / dry_run) it computes directly. */
export class AvailabilityService {
  constructor(private db: AnyDb, private redis?: Redis) {}

  async getSlots(q: SlotQuery): Promise<Slot[]> {
    const k = key(q.serviceAddressId, q.earliest);
    if (this.redis) {
      const hit = await this.redis.get(k).catch(() => null);
      if (hit) return JSON.parse(hit) as Slot[];
    }
    const slots = await computeSlots(this.db, q);
    if (this.redis) await this.redis.set(k, JSON.stringify(slots), "EX", SLOT_TTL_SEC).catch((e: unknown) => logger.warn({ e }, "slot cache write failed"));
    return slots;
  }

  /** Called on HCP job.scheduled / job.completed webhooks and after every materialize. */
  async invalidate(): Promise<number> {
    if (!this.redis) return 0;
    let n = 0, cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", "slots:*", "COUNT", 100);
      cursor = next;
      if (keys.length) n += await this.redis.del(...keys);
    } while (cursor !== "0");
    return n;
  }
}
