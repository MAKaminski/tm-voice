import { and, eq, inArray } from "drizzle-orm";
import { account, callTask, campaign, contact } from "@tm/db";
import { logger } from "@tm/shared";
import type { Ctx, Processor } from "../context.js";

/**
 * Apollo returns whatever the CRM holds — "(404) 555-0100", "404-555-0100", "+1 404 555 0100".
 * Only unambiguous NANP numbers are accepted: everything downstream (the gate, Telnyx lookup,
 * SUPPRESSION uniqueness) keys on E.164, so a guess here would corrupt all three.
 */
export function toE164(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  // Already-plus-prefixed international numbers pass through only if they look like E.164.
  return /^\+[1-9]\d{6,14}$/.test(raw.trim()) ? raw.trim() : null;
}

const displayName = (c: { first_name?: string; last_name?: string }) =>
  [c.first_name, c.last_name].filter(Boolean).join(" ").trim();

export interface SyncStats { campaigns: number; contacts: number; tasks: number; skipped_no_phone: number }

/**
 * Pulls an active campaign's Apollo saved search into ACCOUNT / CONTACT / CALL_TASK so the dial
 * orchestrator has something to claim. Nothing created call_task rows before this, which made the
 * whole dialer a silent no-op.
 *
 * Idempotent three ways: accounts and contacts are matched on their Apollo ids before insert, and
 * call_task relies on the (campaign_id, contact_id) unique index — one task per contact per
 * campaign, with re-attempts incrementing attempt_no on that row rather than adding new ones.
 */
export const apolloSyncCampaign: Processor<{ campaign_id?: string }> = async (ctx, payload) => {
  const stats: SyncStats = { campaigns: 0, contacts: 0, tasks: 0, skipped_no_phone: 0 };
  const where = payload.campaign_id ? eq(campaign.id, payload.campaign_id) : eq(campaign.status, "active");
  const campaigns = await ctx.db.select().from(campaign).where(where);

  for (const camp of campaigns) {
    if (!camp.apolloSavedSearchId) {
      logger.warn({ campaign_id: camp.id }, "campaign has no apollo_saved_search_id; nothing to sync");
      continue;
    }
    stats.campaigns++;
    const people = await ctx.adapters.apollo.listSavedSearchContacts(camp.apolloSavedSearchId);

    for (const p of people) {
      const phone = toE164(p.phone);
      if (!phone) { stats.skipped_no_phone++; continue; }

      // Account: keyed on the Apollo organization so contacts from one company share it.
      const apolloAccountId = p.organization_id ?? null;
      let accountId: string | undefined;
      if (apolloAccountId) {
        const [existing] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.apolloAccountId, apolloAccountId)).limit(1);
        accountId = existing?.id;
      }
      if (!accountId) {
        const [row] = await ctx.db.insert(account)
          .values({ name: displayName(p) || apolloAccountId || "Unknown (Apollo)", apolloAccountId })
          .returning({ id: account.id });
        accountId = row!.id;
      }

      // Contact: keyed on the Apollo contact id. Phone changes are picked up; line_type is left
      // alone so the gate's own 90-day lookup owns it.
      const [existingContact] = await ctx.db.select().from(contact).where(eq(contact.apolloContactId, p.id)).limit(1);
      let contactId: string;
      if (existingContact) {
        contactId = existingContact.id;
        if (existingContact.phoneE164 !== phone) {
          // A new number has never been carrier-checked, so clear the stamp to force a re-lookup.
          await ctx.db.update(contact)
            .set({ phoneE164: phone, lineType: "unknown", lineTypeCheckedAt: null, dncCheckedAt: null, updatedAt: new Date() })
            .where(eq(contact.id, contactId));
        }
      } else {
        const [row] = await ctx.db.insert(contact).values({
          accountId, phoneE164: phone, apolloContactId: p.id,
          firstName: p.first_name ?? null, lastName: p.last_name ?? null, email: p.email ?? null,
        }).returning({ id: contact.id });
        contactId = row!.id;
        stats.contacts++;
      }

      const [task] = await ctx.db.insert(callTask)
        .values({ campaignId: camp.id, contactId })
        .onConflictDoNothing({ target: [callTask.campaignId, callTask.contactId] })
        .returning({ id: callTask.id });
      if (task) stats.tasks++;
    }
  }

  logger.info(stats, "apollo campaign sync complete");
  return stats;
};

/** Re-queues tasks whose call ended without a booking, up to the campaign's max_attempts. */
export const dialRequeue: Processor<{ campaign_id?: string }> = async (ctx) => {
  const rows = await ctx.db.select({ id: callTask.id }).from(callTask)
    .innerJoin(campaign, eq(campaign.id, callTask.campaignId))
    .where(and(eq(callTask.status, "blocked"), inArray(callTask.gateResult, ["window", "did_cap"])));
  if (!rows.length) return { requeued: 0 };
  // 'window' and 'did_cap' are timing refusals, not verdicts about the contact: the same task is
  // eligible again later. surface/suppressed/dnc/attempts are terminal and stay blocked.
  await ctx.db.update(callTask).set({ status: "queued", gateResult: null, updatedAt: new Date() })
    .where(inArray(callTask.id, rows.map((r) => r.id)));
  return { requeued: rows.length };
};
