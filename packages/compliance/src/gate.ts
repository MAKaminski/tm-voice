import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Adapters } from "@tm/adapters";
import { type AnyDb, call, callTask, campaign, consentEvent, contact, did, suppression } from "@tm/db";
import type { Config, GateResult, LineType, TargetSurface } from "@tm/shared";
import { inCallingWindow } from "./calling-window.js";
import { type ConsentSnapshot, surfaceAllows } from "./surface.js";

export interface GateInput {
  surface: TargetSurface;
  allowMaRecording: boolean;
  contact: { phoneE164: string; lineType: LineType; state: string | null; timezone: string };
  consent: ConsentSnapshot;
  suppressed: boolean;
  dnc: { federal: boolean; state: boolean };
  now: Date;
  did: { dialsToday: number; dailyCap: number };
  attemptNo: number;
  maxAttempts: number;
}
export interface GateOutcome { result: GateResult; reason?: string }

/**
 * Pure. Six checks in the mandated order; first failure wins. No I/O so every branch is unit-testable.
 * 1 surface · 2 suppression · 3 DNC · 4 calling window · 5 per-DID cap · 6 attempt cap
 */
export function runGate(i: GateInput): GateOutcome {
  const s = surfaceAllows(i.surface, i.contact.lineType, i.consent);
  if (!s.ok) return { result: "surface", reason: s.reason };
  if (i.contact.state?.toUpperCase() === "MA" && !i.allowMaRecording) return { result: "surface", reason: "MA excluded: two-party recording consent (ALLOW_MA_RECORDING=false)" };
  if (i.suppressed) return { result: "suppressed", reason: "phone_e164 on SUPPRESSION" };
  if (i.dnc.federal || i.dnc.state) return { result: "dnc", reason: i.dnc.federal ? "federal DNC" : "state DNC" };
  if (!inCallingWindow(i.now, i.contact.timezone, i.contact.state)) return { result: "window", reason: `outside calling window in ${i.contact.timezone}` };
  if (i.did.dialsToday >= i.did.dailyCap) return { result: "did_cap", reason: `DID at ${i.did.dialsToday}/${i.did.dailyCap}` };
  if (i.attemptNo >= i.maxAttempts) return { result: "attempts", reason: `attempt ${i.attemptNo} >= ${i.maxAttempts}` };
  return { result: "pass" };
}

const DNC_CACHE_MS = 30 * 86_400_000;
/**
 * How long a Telnyx carrier lookup is trusted. Numbers do get ported between wireline and
 * wireless, and a stale "landline" is exactly the error that dials a mobile, so this refreshes
 * rather than resolving once and trusting it forever.
 */
export const LINE_TYPE_CACHE_MS = 90 * 86_400_000;

export interface ClaimOptions { campaignId?: string; didId: string; now?: Date }
export interface ClaimResult {
  task: typeof callTask.$inferSelect;
  contact: typeof contact.$inferSelect;
  campaign: typeof campaign.$inferSelect;
  outcome: GateOutcome;
}

/**
 * Claims the next eligible CALL_TASK with SKIP LOCKED, runs the gate, and writes gate_result in the SAME transaction.
 * Returns null when nothing is queued. Only outcome.result === 'pass' may proceed to the vapi/telnyx adapters.
 */
export async function gateAndClaim(db: AnyDb, adapters: Pick<Adapters, "dnc" | "telnyx">, cfg: Config, opts: ClaimOptions): Promise<ClaimResult | null> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const where = [eq(callTask.status, "queued"), sql`${callTask.earliestDialAt} <= ${now.toISOString()}`];
    if (opts.campaignId) where.push(eq(callTask.campaignId, opts.campaignId));
    const [task] = await tx.select().from(callTask).where(and(...where)).orderBy(callTask.earliestDialAt).limit(1).for("update", { skipLocked: true });
    if (!task) return null;

    const [c] = await tx.select().from(contact).where(eq(contact.id, task.contactId));
    const [camp] = await tx.select().from(campaign).where(eq(campaign.id, task.campaignId));
    const [d] = await tx.select().from(did).where(eq(did.id, opts.didId));
    if (!c || !camp || !d) throw new Error(`gateAndClaim: dangling refs on call_task ${task.id}`);

    const [sup] = await tx.select({ id: suppression.id }).from(suppression).where(eq(suppression.phoneE164, c.phoneE164)).limit(1);
    const [grant] = await tx.select({ at: consentEvent.occurredAt }).from(consentEvent)
      .where(and(eq(consentEvent.contactId, c.id), eq(consentEvent.eventType, "grant"))).orderBy(desc(consentEvent.occurredAt)).limit(1);
    const [revoke] = await tx.select({ at: consentEvent.occurredAt }).from(consentEvent)
      .where(and(eq(consentEvent.contactId, c.id), eq(consentEvent.eventType, "revoke"))).orderBy(desc(consentEvent.occurredAt)).limit(1);

    // DNC: cache 30 days on the contact row. With DNC_SCRUB=off the registry is never consulted
    // and DNC_API_KEY is not required, but runGate still sees whatever is cached — so a number
    // that was ever flagged stays blocked. "off" removes the lookup, not the knowledge.
    let dnc = { federal: c.dncFederal, state: c.dncState };
    const dncStale = !c.dncCheckedAt || now.getTime() - c.dncCheckedAt.getTime() > DNC_CACHE_MS;
    if (cfg.DNC_SCRUB !== "off" && dncStale) {
      dnc = await adapters.dnc.lookup(c.phoneE164);
      await tx.update(contact).set({ dncFederal: dnc.federal, dncState: dnc.state, dncCheckedAt: now }).where(eq(contact.id, c.id));
    }

    // line_type: cache 90 days, same shape as DNC above. contact.line_type defaults to 'unknown',
    // which landline_only refuses, so without this every task gates as 'surface' forever.
    // A lookup failure is deliberately left to propagate: the transaction rolls back, the task
    // stays 'queued' and the job retries, rather than being written off as permanently blocked.
    let lineTypeValue = c.lineType;
    if (!c.lineTypeCheckedAt || now.getTime() - c.lineTypeCheckedAt.getTime() > LINE_TYPE_CACHE_MS) {
      const looked = await adapters.telnyx.lookupLineType(c.phoneE164);
      lineTypeValue = looked.line_type;
      await tx.update(contact).set({ lineType: lineTypeValue, lineTypeCheckedAt: now }).where(eq(contact.id, c.id));
    }

    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const [dials] = await tx.select({ n: count() }).from(call).where(and(eq(call.didId, d.id), gte(call.startedAt, dayStart)));

    const outcome = runGate({
      surface: cfg.COMPLIANCE_TARGET_SURFACE,
      allowMaRecording: cfg.ALLOW_MA_RECORDING,
      contact: { phoneE164: c.phoneE164, lineType: lineTypeValue, state: c.state, timezone: c.timezone },
      consent: { latestGrantAt: grant?.at ?? null, latestRevokeAt: revoke?.at ?? null },
      suppressed: !!sup,
      dnc,
      now,
      did: { dialsToday: Number(dials?.n ?? 0), dailyCap: d.dailyCap },
      attemptNo: task.attemptNo,
      maxAttempts: camp.maxAttempts,
    });

    const [updated] = await tx.update(callTask).set({
      gateResult: outcome.result,
      status: outcome.result === "pass" ? "claimed" : "blocked",
      claimedAt: now,
      attemptNo: outcome.result === "pass" ? task.attemptNo + 1 : task.attemptNo,
      updatedAt: now,
    }).where(eq(callTask.id, task.id)).returning();

    return { task: updated!, contact: { ...c, lineType: lineTypeValue, dncFederal: dnc.federal, dncState: dnc.state }, campaign: camp, outcome };
  });
}
