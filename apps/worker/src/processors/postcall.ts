import { and, eq, gte, sql } from "drizzle-orm";
import { assertFirstUtterance, suppress } from "@tm/compliance";
import { booking, call, callTask, campaign, contact, scriptVersion, suppression, transcript } from "@tm/db";
import { type Disposition, idempotencyKey, logger } from "@tm/shared";
import type { Processor } from "../context.js";

/** One turn of the call as Vapi reports it, reduced to what we keep. */
export interface Turn { role: "assistant" | "customer" | "tool"; text: string; at_sec: number }

/** What POST /webhooks/vapi extracts from an end-of-call-report and hands to postcall.process. */
export type PostcallPayload = {
  vapi_call_id: string;
  call_task_id?: string;
  ended_reason: string;
  started_at?: string;
  ended_at?: string;
  cost_usd?: number;
  summary?: string;
  /** analysisPlan.structuredDataPlan output; `outcome` is the one field the pipeline reads. */
  structured?: Record<string, unknown>;
  /** Vapi's stored recording. Short-lived, which is why storing it is a separate retryable job. */
  recording_url?: string;
  turns: Turn[];
};

/** Outcomes that close the task for this campaign; everything else is retried until max_attempts. */
const TERMINAL: readonly Disposition[] = ["booked", "opt_out", "not_interested", "wrong_number"];
const RETRY_HOURS: Partial<Record<Disposition, number>> = { failed: 1, busy: 4, no_answer: 48, voicemail: 48, callback: 24 };

/** analysis outcome (case-insensitive) → disposition. Covers the walkthrough script and the vendor-intake script. */
const STRUCTURED_OUTCOMES: Record<string, Disposition> = {
  callback: "callback", not_interested: "not_interested", wrong_number: "wrong_number",
  voicemail: "voicemail", no_answer: "no_answer", interested: "callback", opt_out: "opt_out",
  // Vendor intake (script v3): a captured contact or packet is a human follow-up, and the call's job is done.
  contact_captured: "callback", packet_captured: "callback", callback_requested: "callback",
  gatekeeper_blocked: "callback", not_taking_vendors: "not_interested",
};
/** Outcomes that finish the task even though a human follows up (disposition stays callback). */
const CLOSES_TASK = new Set(["contact_captured", "packet_captured"]);
const outcomeKey = (o: unknown) => (typeof o === "string" ? o.trim().toLowerCase() : "");

/**
 * The email address the assistant captured, if the analysis plan produced a usable one. Validated
 * rather than trusted: a transcriber hearing an address read aloud produces near-misses often
 * enough that writing one unchecked onto a contact would poison the record.
 */
export function capturedEmail(structured: Record<string, unknown> | undefined): string | undefined {
  const raw = structured?.["contact_email"];
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v) ? v : undefined;
}

/**
 * Pure. Facts we own (a booking or an opt-out written during the call) beat Vapi's ended reason,
 * which beats the model's own reading of the call.
 */
export function dispositionFor(i: { endedReason: string; booked: boolean; optedOut: boolean; customerTurns: number; structuredOutcome?: unknown }): Disposition {
  if (i.optedOut) return "opt_out";
  if (i.booked) return "booked";
  const r = i.endedReason;
  if (r === "voicemail") return "voicemail";
  if (r === "customer-busy") return "busy";
  if (r === "customer-did-not-answer") return "no_answer";
  if (/error|failed|fault|not-found|not-valid|join-timed-out/.test(r)) return "failed";
  const s = STRUCTURED_OUTCOMES[outcomeKey(i.structuredOutcome)];
  if (s) return s;
  return i.customerTurns === 0 ? "no_answer" : "callback";
}

/** Writes the call's result, its transcript, and the task's next step. Idempotent on vapi_call_id. */
export const postcallProcess: Processor<PostcallPayload> = async (ctx, p) => {
  const [c] = await ctx.db.select().from(call).where(eq(call.vapiCallId, p.vapi_call_id)).limit(1);
  if (!c) { logger.warn({ vapi_call_id: p.vapi_call_id }, "end-of-call report for a call we did not place; ignored"); return { skipped: "unknown_call" }; }
  if (c.disposition) return { skipped: "already_processed", disposition: c.disposition };

  const [task] = await ctx.db.select().from(callTask).where(eq(callTask.id, c.callTaskId));
  const [ct] = task ? await ctx.db.select().from(contact).where(eq(contact.id, task.contactId)) : [];
  const [camp] = task ? await ctx.db.select().from(campaign).where(eq(campaign.id, task.campaignId)) : [];

  const [b] = await ctx.db.select({ id: booking.id }).from(booking).where(eq(booking.callId, c.id)).limit(1);
  const [s] = ct ? await ctx.db.select({ id: suppression.id }).from(suppression)
    .where(and(eq(suppression.phoneE164, ct.phoneE164), gte(suppression.createdAt, c.startedAt))).limit(1) : [];
  const customerTurns = p.turns.filter((t) => t.role === "customer").length;
  const outcome = outcomeKey(p.structured?.["outcome"]);

  // The assistant sometimes reads an email back correctly but never calls capture_contact, so the
  // address only exists in the call analysis. Persisting it here means the next call already has
  // it instead of opening with "I don't have an email address on file" again.
  const heardEmail = capturedEmail(p.structured);
  if (heardEmail && ct && !ct.email) {
    await ctx.db.update(contact).set({ email: heardEmail, updatedAt: new Date() }).where(eq(contact.id, ct.id));
    logger.info({ contact_id: ct.id, call_id: c.id }, "email captured from call analysis");
  }
  // The assistant heard an opt-out but no opt_out tool call wrote it: write it now, so the number is never dialed again.
  if (outcome === "opt_out" && !s && ct) {
    await suppress(ctx.db, { phoneE164: ct.phoneE164, reason: "opt-out heard on call (post-call analysis)", channel: "phone", callId: c.id, artifact: { vapi_call_id: p.vapi_call_id } });
  }
  const disposition = dispositionFor({ endedReason: p.ended_reason, booked: !!b, optedOut: !!s, customerTurns, structuredOutcome: p.structured?.["outcome"] });

  // Rule 10 runtime check: the first thing the assistant said must be the fixed disclosure line.
  let disclosureOk: boolean | null = null;
  const first = p.turns.find((t) => t.role === "assistant");
  if (first && camp) {
    const [sv] = await ctx.db.select().from(scriptVersion).where(eq(scriptVersion.id, camp.scriptVersionId));
    if (sv) {
      try { assertFirstUtterance(sv.disclosureLine.replace(/[,.]/g, ""), first.text.replace(/[,.]/g, "")); disclosureOk = true; }
      catch { disclosureOk = false; logger.error({ call_id: c.id, vapi_call_id: p.vapi_call_id }, "disclosure line not spoken verbatim"); }
    }
  }

  const endedAt = p.ended_at ? new Date(p.ended_at) : new Date();
  const startedAt = p.started_at ? new Date(p.started_at) : c.startedAt;
  await ctx.db.transaction(async (tx) => {
    await tx.update(call).set({
      disposition, endedAt, disclosureOk,
      durationSec: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
      costUsd: (p.cost_usd ?? 0).toFixed(4), updatedAt: new Date(),
    }).where(eq(call.id, c.id));
    await tx.insert(transcript).values({
      callId: c.id, turns: p.turns, summary: p.summary ?? null, structured: p.structured ?? null,
    });
    if (!task) return;
    const exhausted = camp ? task.attemptNo >= camp.maxAttempts : false;
    if (TERMINAL.includes(disposition) || CLOSES_TASK.has(outcome) || (exhausted && disposition !== "failed")) {
      await tx.update(callTask).set({ status: "done", updatedAt: new Date() }).where(eq(callTask.id, task.id));
    } else {
      const hours = RETRY_HOURS[disposition] ?? 24;
      await tx.update(callTask).set({
        status: "queued", gateResult: null, claimedAt: null,
        earliestDialAt: new Date(endedAt.getTime() + hours * 3_600_000),
        // A failure on our side (vendor or pipeline error) must not use up one of the contact's attempts.
        ...(disposition === "failed" ? { attemptNo: sql`greatest(${callTask.attemptNo} - 1, 0)` } : {}),
        updatedAt: new Date(),
      }).where(eq(callTask.id, task.id));
    }
  });

  /**
   * Storing the recording is its own job. The disposition, transcript and retry schedule above are
   * the part that must not be recomputed, and inlining the download would mean a transient R2 or
   * Vapi failure re-runs all of it. Vapi's recording URL is also short-lived, so this is the step
   * most likely to need retries — which it now gets on its own, with a dead-letter entry naming
   * the call rather than the whole post-call run.
   */
  if (p.recording_url) {
    await ctx.producer.enqueue("postcall", "recording", {
      entity_id: c.id,
      idempotency_key: idempotencyKey("postcall", "recording", p.vapi_call_id),
      attempt: 0,
      enqueued_at: new Date().toISOString(),
      vapi_call_id: p.vapi_call_id,
      recording_url: p.recording_url,
    });
  } else {
    // The disclosure line told the prospect this call was being recorded, so a report with no
    // recording url means either the assistant has recording switched off — which the sync should
    // have corrected — or Vapi dropped it. Worth a line either way.
    logger.warn({ call_id: c.id, vapi_call_id: p.vapi_call_id }, "end-of-call report carried no recording url");
  }

  /**
   * Tell the CRM the call happened. A job, not an inline call: Apollo offers no idempotency header,
   * so the envelope's key is the only thing standing between a webhook retry and a duplicate
   * activity on the contact.
   */
  await ctx.producer.enqueue("apollo", "logCall", {
    entity_id: c.id,
    idempotency_key: idempotencyKey("apollo", "logCall", p.vapi_call_id),
    attempt: 0,
    enqueued_at: new Date().toISOString(),
    vapi_call_id: p.vapi_call_id,
  });

  if (disclosureOk === false) {
    // Already logged at error level above; repeated here at the end of the run so the one line a
    // reader greps for carries the call id and the disposition together.
    logger.error({ call_id: c.id, disposition }, "rule 10 exception: the disclosure line was not spoken verbatim on this call");
  }

  logger.info({ call_id: c.id, disposition, ended_reason: p.ended_reason, customer_turns: customerTurns, disclosure_ok: disclosureOk }, "post-call processed");
  return { call_id: c.id, disposition, disclosure_ok: disclosureOk };
};
