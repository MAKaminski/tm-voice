import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { account, call, callTask, campaign, consentEvent, contact, scriptVersion } from "@tm/db";
import { idempotencyKey, logger } from "@tm/shared";

import type { AppEnv } from "../app.js";
import { internalAuth } from "../middleware.js";

/** The campaign every console-placed test call is filed under, so they never mix with a real list. */
const TEST_CAMPAIGN = "Console test calls";

/**
 * E.164, strictly. Deliberately not a permissive parser: the number typed here is dialled for real
 * in verified_only, and a silently-coerced digit is a call to a stranger.
 */
const testCallBody = z.object({
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "phone must be E.164, e.g. +14045550100"),
  assistant_id: z.string().min(1).optional(),
  /**
   * Not a formality. COMPLIANCE_TARGET_SURFACE=consented_mobile means a mobile is only dialable
   * with a grant in consent_event, and consent_event is append-only evidence. Writing a grant
   * because someone typed a number into a box would be manufacturing that evidence, so the grant
   * is only written against an explicit human attestation, and it records that that is what it is.
   */
  attestation: z.literal(true, { errorMap: () => ({ message: "attestation required: you must confirm you may call this number" }) }),
  attested_by: z.string().min(1).max(120),
});

/**
 * Placing a test call from the console.
 *
 * It does NOT shortcut the dial path. The route only creates the rows the dialer already expects —
 * contact, consent, an active campaign, a queued call_task — and then enqueues the same
 * `dial.claim` job the campaign runner enqueues. `gateAndClaim` still runs, DIAL_MODE is still
 * enforced in the adapter, and a number that fails the gate is still refused. That is the point:
 * a test call that skipped the gate would be testing something other than the system.
 */
export function testCallRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/test-calls", internalAuth, async (c) => {
    const { db, producer, cfg } = c.get("deps");
    const parsed = testCallBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", detail: parsed.error.issues.map((i) => i.message) }, 400);
    }
    const { phone, assistant_id, attested_by } = parsed.data;
    const now = new Date();

    // An active campaign is a precondition of the gate, not a nicety: gateAndClaim only claims
    // tasks whose campaign is active, so without this the task would sit queued forever.
    let [camp] = await db.select().from(campaign).where(eq(campaign.name, TEST_CAMPAIGN));
    if (!camp) {
      const [script] = await db.select().from(scriptVersion).where(eq(scriptVersion.active, true)).limit(1);
      if (!script) return c.json({ error: "no_active_script_version" }, 409);
      [camp] = await db.insert(campaign).values({
        name: TEST_CAMPAIGN, scriptVersionId: script.id, status: "active", dailyDialCap: 20, maxAttempts: 1,
      }).returning();
    } else if (camp.status !== "active") {
      [camp] = await db.update(campaign).set({ status: "active", updatedAt: now }).where(eq(campaign.id, camp.id)).returning();
    }

    let [ct] = await db.select().from(contact).where(eq(contact.phoneE164, phone));
    if (!ct) {
      const [acct] = await db.select().from(account).limit(1);
      if (!acct) return c.json({ error: "no_account" }, 409);
      [ct] = await db.insert(contact).values({
        accountId: acct.id, phoneE164: phone, firstName: "Test", lastName: "Call",
      }).returning();
    }

    // Append-only: a grant is written once per number and never rewritten. capture_artifact is
    // what makes it auditable later — who attested, from where, and that it was a test.
    const [existingGrant] = await db.select({ id: consentEvent.id }).from(consentEvent)
      .where(eq(consentEvent.contactId, ct!.id)).orderBy(desc(consentEvent.occurredAt)).limit(1);
    if (!existingGrant) {
      await db.insert(consentEvent).values({
        contactId: ct!.id, eventType: "grant", channel: "console_test_attestation",
        captureArtifact: {
          source: "console test-call form",
          attested_by,
          attestation: "operator confirmed they own this number or have the account holder's permission to call it for testing",
          attested_at: now.toISOString(),
        },
        occurredAt: now,
      });
      logger.warn({ contact_id: ct!.id, attested_by }, "consent grant written from a console test-call attestation");
    }

    // call_task is unique on (campaign, contact), so a repeat test of the same number resets the
    // existing row rather than failing on the constraint.
    const [task] = await db.insert(callTask).values({
      campaignId: camp!.id, contactId: ct!.id, status: "queued", earliestDialAt: now,
      ...(assistant_id ? { assistantId: assistant_id } : {}),
    }).onConflictDoUpdate({
      target: [callTask.campaignId, callTask.contactId],
      set: {
        status: "queued", gateResult: null, claimedAt: null, attemptNo: 0, earliestDialAt: now,
        assistantId: assistant_id ?? null, updatedAt: now,
      },
    }).returning();

    const enq = await producer.enqueue("dial", "claim", {
      entity_id: task!.id,
      idempotency_key: idempotencyKey("dial", "test", task!.id, now.getTime()),
      attempt: 0,
      enqueued_at: now.toISOString(),
      campaign_id: camp!.id,
    });

    logger.warn(
      { call_task_id: task!.id, contact_id: ct!.id, assistant_id: assistant_id ?? cfg.VAPI_ASSISTANT_ID, dial_mode: cfg.DIAL_MODE },
      "test call enqueued from the console",
    );
    return c.json({
      call_task_id: task!.id,
      contact_id: ct!.id,
      campaign_id: camp!.id,
      assistant_id: assistant_id ?? cfg.VAPI_ASSISTANT_ID ?? null,
      dial_mode: cfg.DIAL_MODE,
      job: enq.id,
    }, 202);
  });

  /**
   * The call log. Every call the system has placed, test or campaign, newest first — there is no
   * separate test ledger, because a test call that is not recorded the same way is not a test of
   * the same thing.
   */
  app.get("/calls", internalAuth, async (c) => {
    const { db } = c.get("deps");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const rows = await db.select({
      id: call.id,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      durationSec: call.durationSec,
      disposition: call.disposition,
      disclosureOk: call.disclosureOk,
      costUsd: call.costUsd,
      vapiCallId: call.vapiCallId,
      phoneE164: contact.phoneE164,
      firstName: contact.firstName,
      lastName: contact.lastName,
      campaignName: campaign.name,
      assistantId: callTask.assistantId,
      gateResult: callTask.gateResult,
      taskStatus: callTask.status,
    })
      .from(call)
      .innerJoin(callTask, eq(call.callTaskId, callTask.id))
      .innerJoin(contact, eq(callTask.contactId, contact.id))
      .innerJoin(campaign, eq(callTask.campaignId, campaign.id))
      .orderBy(desc(call.startedAt))
      .limit(limit);
    return c.json({ calls: rows });
  });

  /**
   * Tasks that never became a call. A gate-blocked test looks like silence in /calls, which reads
   * as "nothing happened" when in fact the system deliberately refused — the most important thing
   * it can tell you.
   */
  app.get("/call-tasks", internalAuth, async (c) => {
    const { db } = c.get("deps");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const rows = await db.select({
      id: callTask.id,
      status: callTask.status,
      gateResult: callTask.gateResult,
      attemptNo: callTask.attemptNo,
      assistantId: callTask.assistantId,
      updatedAt: callTask.updatedAt,
      phoneE164: contact.phoneE164,
      campaignName: campaign.name,
    })
      .from(callTask)
      .innerJoin(contact, eq(callTask.contactId, contact.id))
      .innerJoin(campaign, eq(callTask.campaignId, campaign.id))
      .orderBy(desc(callTask.updatedAt))
      .limit(limit);
    return c.json({ tasks: rows });
  });

  return app;
}
