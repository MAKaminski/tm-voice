import { and, asc, count, eq, gte, sql } from "drizzle-orm";
import { gateAndClaim } from "@tm/compliance";
import { call, callTask, campaign, did } from "@tm/db";
import { idempotencyKey, logger, startOfLocalDay } from "@tm/shared";
import type { Ctx, Processor } from "../context.js";

/** Least-loaded active DID that is still under its daily cap. */
export async function pickDid(ctx: Ctx, now: Date) {
  const dayStart = startOfLocalDay(now, ctx.cfg.DIAL_TIMEZONE);
  const rows = await ctx.db.select({ d: did, n: count(call.id) }).from(did)
    .leftJoin(call, and(eq(call.didId, did.id), gte(call.startedAt, dayStart)))
    .where(eq(did.active, true)).groupBy(did.id).orderBy(asc(count(call.id)));
  return rows.find((r) => Number(r.n) < r.d.dailyCap)?.d ?? null;
}

/**
 * Dial orchestrator (§5.2). Claims the next eligible CALL_TASK, runs the gate in the same transaction,
 * and only on gate_result='pass' asks the vapi adapter for a call. The adapter — not this code — enforces DIAL_MODE.
 * In dry_run the adapter returns a synthetic call and we record disposition='dry_run'.
 */
export const dialClaim: Processor<{ campaign_id?: string }> = async (ctx, payload) => {
  const now = new Date();
  const d = await pickDid(ctx, now);
  if (!d) { logger.warn("no DID under its daily cap; skipping"); return { skipped: "no_did" }; }

  const claim = await gateAndClaim(ctx.db, ctx.adapters, ctx.cfg, { didId: d.id, now, ...(payload.campaign_id ? { campaignId: payload.campaign_id } : {}) });
  if (!claim) return { skipped: "nothing_queued" };
  if (claim.outcome.result !== "pass") {
    logger.info({ call_task_id: claim.task.id, gate: claim.outcome }, "gate blocked");
    return { call_task_id: claim.task.id, gate_result: claim.outcome.result };
  }

  /**
   * The gate has already committed: the task is 'claimed' and its attempt is spent. If the vendor
   * call now throws — and the very first real dial will, with `unknown_from_number`, until a DID is
   * imported into Vapi — the task is left 'claimed' with no call row. Nothing moves a task out of
   * 'claimed': dial.requeue only rescues 'blocked' with a timing gate_result. So the contact was
   * silently and permanently dropped.
   *
   * Put it back to 'queued' and refund the attempt, which is the same judgement postcall.process
   * already makes: a failure on our side must not use up one of the contact's attempts. Then
   * re-throw, so BullMQ retries and a persistent failure reaches the dead-letter queue rather than
   * being swallowed here.
   */
  let res: Awaited<ReturnType<typeof ctx.adapters.vapi.createOutboundCall>>;
  try {
    res = await ctx.adapters.vapi.createOutboundCall({
      to: claim.contact.phoneE164, from: d.phoneE164, assistant_id: ctx.cfg.VAPI_ASSISTANT_ID ?? "mock-assistant",
      metadata: { call_task_id: claim.task.id, contact_id: claim.contact.id },
    });
  } catch (e) {
    await ctx.db.update(callTask).set({
      status: "queued", gateResult: null, claimedAt: null,
      attemptNo: sql`greatest(${callTask.attemptNo} - 1, 0)`,
      updatedAt: new Date(),
    }).where(eq(callTask.id, claim.task.id));
    logger.error(
      { call_task_id: claim.task.id, to: claim.contact.phoneE164, err: (e as Error).message },
      "dial failed after the task was claimed; returned to queued and the attempt refunded",
    );
    throw e;
  }
  const [c] = await ctx.db.insert(call).values({
    callTaskId: claim.task.id, didId: d.id, startedAt: now, vapiCallId: res.id,
    ...(res.synthetic ? { disposition: "dry_run" as const, endedAt: now, durationSec: 0 } : {}),
  }).returning();
  await ctx.db.update(callTask).set({ status: res.synthetic ? "done" : "dialed", updatedAt: now }).where(eq(callTask.id, claim.task.id));
  logger.info({ call_id: c!.id, vapi_call_id: res.id, synthetic: res.synthetic, dial_mode: ctx.cfg.DIAL_MODE }, "dial placed");
  return { call_id: c!.id, gate_result: "pass", synthetic: res.synthetic };
};

/** Campaign runner tick (Phase 6 grows this). For each active campaign under its daily cap, enqueue one claim. */
export const dialTick: Processor = async (ctx) => {
  const now = new Date();
  const dayStart = startOfLocalDay(now, ctx.cfg.DIAL_TIMEZONE);
  const active = await ctx.db.select().from(campaign).where(eq(campaign.status, "active"));
  let enqueued = 0;
  for (const camp of active) {
    const [row] = await ctx.db.select({ n: count() }).from(call).innerJoin(callTask, eq(callTask.id, call.callTaskId))
      .where(and(eq(callTask.campaignId, camp.id), gte(call.startedAt, dayStart)));
    if (Number(row?.n ?? 0) >= camp.dailyDialCap) continue;
    await ctx.producer.enqueue("dial", "claim", {
      entity_id: camp.id, idempotency_key: idempotencyKey("dial", camp.id, now.toISOString()), attempt: 0, enqueued_at: now.toISOString(), campaign_id: camp.id,
    });
    enqueued++;
  }
  return { enqueued };
};
