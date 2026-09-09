import { eq } from "drizzle-orm";
import { type AnyDb, consentEvent, scriptVersion } from "@tm/db";

/** Phase 7 entry point: record a grant with its capture artifact (form payload, IP, e-sign hash). Append-only. */
export async function recordGrant(db: AnyDb, input: { contactId: string; channel: string; artifact: Record<string, unknown>; callId?: string }) {
  const [row] = await db.insert(consentEvent).values({
    contactId: input.contactId, callId: input.callId ?? null, eventType: "grant", channel: input.channel, captureArtifact: input.artifact,
  }).returning();
  return row!;
}

/** The opening line is fixed per SCRIPT_VERSION and must be the first utterance (CLAUDE.md rule 10). */
export async function getDisclosureLine(db: AnyDb, scriptVersionId: string): Promise<string> {
  const [s] = await db.select({ line: scriptVersion.disclosureLine }).from(scriptVersion).where(eq(scriptVersion.id, scriptVersionId));
  if (!s) throw new Error(`script_version ${scriptVersionId} not found`);
  return s.line;
}

export function assertFirstUtterance(disclosureLine: string, firstUtterance: string): void {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  if (!norm(firstUtterance).startsWith(norm(disclosureLine))) throw new Error("first utterance is not the fixed disclosure line");
}
