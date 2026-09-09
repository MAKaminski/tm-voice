import { eq } from "drizzle-orm";
import { type AnyDb, consentEvent, contact, suppression } from "@tm/db";

export interface SuppressInput {
  phoneE164: string;
  reason: string;
  channel: "phone" | "web" | "email" | "manual";
  callId?: string;
  artifact?: Record<string, unknown>;
}

/**
 * Write-through, synchronous. One transaction: SUPPRESSION upsert on phone (never contact)
 * plus a CONSENT_EVENT(revoke) for every contact that carries the number.
 */
export async function suppress(db: AnyDb, input: SuppressInput): Promise<{ suppressed: boolean; revokedContacts: number }> {
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(suppression)
      .values({ phoneE164: input.phoneE164, reason: input.reason, sourceCallId: input.callId ?? null })
      .onConflictDoNothing({ target: suppression.phoneE164 }).returning({ id: suppression.id });
    const contacts = await tx.select({ id: contact.id }).from(contact).where(eq(contact.phoneE164, input.phoneE164));
    if (contacts.length) {
      await tx.insert(consentEvent).values(contacts.map((c) => ({
        contactId: c.id, callId: input.callId ?? null, eventType: "revoke" as const, channel: input.channel,
        captureArtifact: { reason: input.reason, ...(input.artifact ?? {}) },
      })));
    }
    return { suppressed: inserted.length > 0, revokedContacts: contacts.length };
  });
}

export async function isSuppressed(db: AnyDb, phoneE164: string): Promise<boolean> {
  const [r] = await db.select({ id: suppression.id }).from(suppression).where(eq(suppression.phoneE164, phoneE164)).limit(1);
  return !!r;
}
