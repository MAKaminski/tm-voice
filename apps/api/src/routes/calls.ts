import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { account, call, callTask, campaign, consentEvent, contact, scriptVersion } from "@tm/db";
import { idempotencyKey, logger } from "@tm/shared";

import type { AppEnv } from "../app.js";
import { internalAuth } from "../middleware.js";

/** The campaign every console-placed test call is filed under, so they never mix with a real list. */
const TEST_CAMPAIGN = "Console test calls";
/** Calls started from TM-OS's pipeline board. Separate from tests so the two never share a list. */
const PIPELINE_CAMPAIGN = "Pipeline calls";

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
 * A prospect call from TM-OS. No attestation, because there is nothing truthful for the operator to
 * attest to about a stranger's number — the gate decides instead. `requested_by` is here for the
 * log, so a call that goes out can be traced to the person who pressed the button.
 */
const outboundCallBody = z.object({
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "phone must be E.164, e.g. +14045550100"),
  assistant_id: z.string().min(1).optional(),
  requested_by: z.string().min(1).max(120),
  account_name: z.string().min(1).max(200).optional(),
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
export function callRoutes() {
  const app = new Hono<AppEnv>();

  /**
   * Everything both routes need before a dial can be claimed: an active campaign, a contact, a
   * queued task, and the job. Shared so the two entry points cannot drift on the parts that decide
   * whether the gate will even look at the task.
   *
   * It deliberately does NOT touch consent. The two callers have different lawful bases for the
   * call, so each decides that for itself — see the routes below.
   */
  const queue = async (
    deps: AppEnv["Variables"]["deps"],
    opts: { phone: string; assistantId?: string | undefined; campaignName: string; name: [string, string]; tag: string },
  ): Promise<{ error: string } | { task: { id: string }; contactId: string; campaignId: string; job: string }> => {
    const { db, producer } = deps;
    const now = new Date();

    // An active campaign is a precondition of the gate, not a nicety: gateAndClaim only claims
    // tasks whose campaign is active, so without this the task would sit queued forever.
    let [camp] = await db.select().from(campaign).where(eq(campaign.name, opts.campaignName));
    if (!camp) {
      const [script] = await db.select().from(scriptVersion).where(eq(scriptVersion.active, true)).limit(1);
      if (!script) return { error: "no_active_script_version" };
      [camp] = await db.insert(campaign).values({
        name: opts.campaignName, scriptVersionId: script.id, status: "active", dailyDialCap: 20, maxAttempts: 1,
      }).returning();
    } else if (camp.status !== "active") {
      [camp] = await db.update(campaign).set({ status: "active", updatedAt: now }).where(eq(campaign.id, camp.id)).returning();
    }

    let [ct] = await db.select().from(contact).where(eq(contact.phoneE164, opts.phone));
    if (!ct) {
      const [acct] = await db.select().from(account).limit(1);
      if (!acct) return { error: "no_account" };
      [ct] = await db.insert(contact).values({
        accountId: acct.id, phoneE164: opts.phone, firstName: opts.name[0], lastName: opts.name[1],
      }).returning();
    }

    // call_task is unique on (campaign, contact), so calling the same number again resets the
    // existing row rather than failing on the constraint.
    const [task] = await db.insert(callTask).values({
      campaignId: camp!.id, contactId: ct!.id, status: "queued", earliestDialAt: now,
      ...(opts.assistantId ? { assistantId: opts.assistantId } : {}),
    }).onConflictDoUpdate({
      target: [callTask.campaignId, callTask.contactId],
      set: {
        status: "queued", gateResult: null, claimedAt: null, attemptNo: 0, earliestDialAt: now,
        assistantId: opts.assistantId ?? null, updatedAt: now,
      },
    }).returning();

    const enq = await producer.enqueue("dial", "claim", {
      entity_id: task!.id,
      idempotency_key: idempotencyKey("dial", opts.tag, task!.id, now.getTime()),
      attempt: 0,
      enqueued_at: now.toISOString(),
      campaign_id: camp!.id,
    });
    return { task: task!, contactId: ct!.id, campaignId: camp!.id, job: enq.id };
  };

  app.post("/test-calls", internalAuth, async (c) => {
    const deps = c.get("deps");
    const { db, cfg } = deps;
    const parsed = testCallBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", detail: parsed.error.issues.map((i) => i.message) }, 400);
    }
    const { phone, assistant_id, attested_by } = parsed.data;
    const now = new Date();

    const out = await queue(deps, {
      phone, assistantId: assistant_id, campaignName: TEST_CAMPAIGN, name: ["Test", "Call"], tag: "test",
    });
    if ("error" in out) return c.json({ error: out.error }, 409);

    // Append-only: a grant is written once per number and never rewritten. capture_artifact is
    // what makes it auditable later — who attested, from where, and that it was a test.
    const [existingGrant] = await db.select({ id: consentEvent.id }).from(consentEvent)
      .where(eq(consentEvent.contactId, out.contactId)).orderBy(desc(consentEvent.occurredAt)).limit(1);
    if (!existingGrant) {
      await db.insert(consentEvent).values({
        contactId: out.contactId, eventType: "grant", channel: "console_test_attestation",
        captureArtifact: {
          source: "console test-call form",
          attested_by,
          attestation: "operator confirmed they own this number or have the account holder's permission to call it for testing",
          attested_at: now.toISOString(),
        },
        occurredAt: now,
      });
      logger.warn({ contact_id: out.contactId, attested_by }, "consent grant written from a console test-call attestation");
    }

    logger.warn(
      { call_task_id: out.task.id, contact_id: out.contactId, assistant_id: assistant_id ?? cfg.VAPI_ASSISTANT_ID, dial_mode: cfg.DIAL_MODE },
      "test call enqueued from the console",
    );
    return c.json({
      call_task_id: out.task.id,
      contact_id: out.contactId,
      campaign_id: out.campaignId,
      assistant_id: assistant_id ?? cfg.VAPI_ASSISTANT_ID ?? null,
      dial_mode: cfg.DIAL_MODE,
      job: out.job,
    }, 202);
  });

  /**
   * A call to a prospect, started from TM-OS's pipeline board.
   *
   * The difference from /test-calls is consent, and it is deliberate. A test call is to a number
   * the operator owns, so they attest to it and that attestation is recorded as a grant. A prospect
   * has given no such permission, so **this route writes no consent at all** — it lets the gate
   * decide. A business landline passes; a mobile is refused with gate_result 'surface' under
   * COMPLIANCE_TARGET_SURFACE=consented_mobile, and that refusal is the correct outcome rather than
   * something to design around. Writing a grant here would manufacture the evidence the gate exists
   * to check.
   *
   * It returns 202 on *queued*, never on *dialled*: whether the call happens is the gate's to say,
   * minutes later. The caller has to read the task's gate_result to find out.
   */
  app.post("/outbound-calls", internalAuth, async (c) => {
    const deps = c.get("deps");
    const { cfg } = deps;
    const parsed = outboundCallBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", detail: parsed.error.issues.map((i) => i.message) }, 400);
    }
    const { phone, assistant_id, requested_by, account_name } = parsed.data;

    const out = await queue(deps, {
      phone, assistantId: assistant_id, campaignName: PIPELINE_CAMPAIGN,
      name: [(account_name ?? "Prospect").slice(0, 60), ""], tag: "pipeline",
    });
    if ("error" in out) return c.json({ error: out.error }, 409);

    logger.warn(
      { call_task_id: out.task.id, contact_id: out.contactId, requested_by, account_name, dial_mode: cfg.DIAL_MODE },
      "pipeline call enqueued from TM-OS",
    );
    return c.json({
      call_task_id: out.task.id,
      contact_id: out.contactId,
      campaign_id: out.campaignId,
      assistant_id: assistant_id ?? cfg.VAPI_ASSISTANT_ID ?? null,
      dial_mode: cfg.DIAL_MODE,
      job: out.job,
      note: "queued, not dialled — the pre-dial gate decides, and a mobile without consent is refused",
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
