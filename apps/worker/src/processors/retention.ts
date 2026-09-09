import { eq, lt } from "drizzle-orm";
import { recording } from "@tm/db";
import { logger } from "@tm/shared";
import type { Processor } from "../context.js";

/** Deletes R2 objects whose retain_until has passed. Never earlier — the DB check constraint guarantees ≥ 5 years. */
export const retentionSweep: Processor = async (ctx) => {
  const today = new Date().toISOString().slice(0, 10);
  const due = await ctx.db.select().from(recording).where(lt(recording.retainUntil, today));
  for (const r of due) {
    await ctx.adapters.r2.deleteObject(r.r2Key);
    await ctx.db.delete(recording).where(eq(recording.id, r.id));
    logger.info({ recording_id: r.id, r2_key: r.r2Key, retain_until: r.retainUntil }, "recording purged");
  }
  return { purged: due.length };
};
