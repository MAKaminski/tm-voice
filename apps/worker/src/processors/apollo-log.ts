import { account, call, callTask, contact, did, recording, transcript } from "@tm/db";
import { type Disposition, logger } from "@tm/shared";
import { eq } from "drizzle-orm";
import type { Processor } from "../context.js";

/** What postcall.process enqueues once a call has a disposition. */
export type ApolloLogPayload = { vapi_call_id: string };

/** How long a recording link in a CRM note stays usable. R2 caps a presigned url at 7 days. */
export const NOTE_LINK_TTL_SEC = 7 * 24 * 3_600;

/**
 * Our disposition, in the words Apollo's call log uses. Apollo's own outcome ids are per-workspace
 * and we have none configured, so `phone_call_outcome_id` is deliberately left unset and the
 * disposition is carried in `status` and the note instead. A wrong outcome id is worse than none:
 * it would file every call under someone else's taxonomy and be invisible to fix.
 */
export const APOLLO_STATUS: Record<Disposition, string> = {
  booked: "Completed", callback: "Completed", not_interested: "Completed",
  opt_out: "Completed", wrong_number: "Completed",
  voicemail: "Voicemail", no_answer: "No Answer", busy: "Busy",
  failed: "Failed", dry_run: "Completed",
};

/** The note is the only place Apollo can hold a summary or a recording; it has no field for either. */
export function buildNote(input: {
  disposition: Disposition;
  summary: string | null;
  recordingUrl: string | null;
  disclosureOk: boolean | null;
}): string {
  const lines = [`Outcome: ${input.disposition}.`];
  if (input.summary) lines.push("", input.summary);
  if (input.recordingUrl) lines.push("", `Recording (expires in 7 days): ${input.recordingUrl}`);
  // Surfaced in the CRM as well as the logs: a call whose opening line was not spoken verbatim is
  // a compliance exception, and the person following up on the account should see it.
  if (input.disclosureOk === false) lines.push("", "⚠️ The required disclosure line was not spoken verbatim on this call.");
  return lines.join("\n").slice(0, 10_000);
}

/**
 * Log a completed call to Apollo.
 *
 * This was a stub — `stub("apollo", 5)` — while the adapter method underneath it was written and
 * tested. Nothing enqueued it either, so the CRM never learned that any call had happened: no
 * activity on the contact, no way for whoever picks the account up next to know it was dialled.
 *
 * Apollo offers no idempotency header, which the adapter says explicitly. The job envelope's key
 * is therefore the only guard against double-logging, and that is exactly why this is a job and
 * not an inline step — BullMQ dedupes on the key, an inline call would not.
 */
export const apolloLogCall: Processor<ApolloLogPayload> = async (ctx, p) => {
  const [row] = await ctx.db.select({ call, task: callTask, contact, account, did })
    .from(call)
    .innerJoin(callTask, eq(callTask.id, call.callTaskId))
    .innerJoin(contact, eq(contact.id, callTask.contactId))
    .innerJoin(account, eq(account.id, contact.accountId))
    .leftJoin(did, eq(did.id, call.didId))
    .where(eq(call.vapiCallId, p.vapi_call_id))
    .limit(1);

  if (!row) {
    logger.warn({ vapi_call_id: p.vapi_call_id }, "apollo.logCall for a call we did not place; ignored");
    return { skipped: "unknown_call" };
  }
  const c = row.call;
  if (c.apolloPhoneCallId) return { skipped: "already_logged", apollo_phone_call_id: c.apolloPhoneCallId };
  if (!c.disposition) return { skipped: "no_disposition_yet" };
  if (!row.did) {
    // Apollo requires both numbers; a call with no DID row cannot be logged truthfully.
    logger.warn({ call_id: c.id }, "apollo.logCall: call has no DID, cannot report a from-number");
    return { skipped: "no_did" };
  }

  const [tr] = await ctx.db.select({ summary: transcript.summary }).from(transcript).where(eq(transcript.callId, c.id)).limit(1);

  // A signed link rather than the R2 key: Apollo's note is read by a person, and the key is
  // meaningless to them. Seven days is R2's ceiling, and the note says so.
  let recordingUrl: string | null = null;
  const [rec] = await ctx.db.select({ r2Key: recording.r2Key }).from(recording).where(eq(recording.callId, c.id)).limit(1);
  if (rec) {
    try {
      recordingUrl = (await ctx.adapters.r2.getSignedUrl(rec.r2Key, NOTE_LINK_TTL_SEC)).url;
    } catch (e) {
      // A missing link is worth less than a missing activity: log the call without it.
      logger.warn({ call_id: c.id, err: (e as Error).message }, "could not sign the recording link; logging the call without it");
    }
  }

  const endedAt = c.endedAt ?? c.startedAt;
  const res = await ctx.adapters.apollo.logPhoneCall({
    ...(row.contact.apolloContactId ? { contact_id: row.contact.apolloContactId } : {}),
    ...(row.account.apolloAccountId ? { account_id: row.account.apolloAccountId } : {}),
    to_number: row.contact.phoneE164,
    from_number: row.did.phoneE164,
    status: APOLLO_STATUS[c.disposition],
    start_time: c.startedAt.toISOString(),
    end_time: endedAt.toISOString(),
    duration: c.durationSec,
    note: buildNote({
      disposition: c.disposition,
      summary: tr?.summary ?? null,
      recordingUrl,
      disclosureOk: c.disclosureOk,
    }),
  }, p.vapi_call_id);

  await ctx.db.update(call).set({ apolloPhoneCallId: res.id, updatedAt: new Date() }).where(eq(call.id, c.id));
  logger.info({ call_id: c.id, apollo_phone_call_id: res.id, disposition: c.disposition }, "call logged to Apollo");
  return { call_id: c.id, apollo_phone_call_id: res.id };
};
