import type { LineType, TargetSurface } from "@tm/shared";

export interface ConsentSnapshot { latestGrantAt: Date | null; latestRevokeAt: Date | null }

export function hasActiveGrant(c: ConsentSnapshot): boolean {
  if (!c.latestGrantAt) return false;
  return !c.latestRevokeAt || c.latestGrantAt > c.latestRevokeAt;
}

/**
 * landline_only: line_type must be landline. Nothing else, ever.
 * consented_mobile: wireless needs a grant newer than any revoke; landline still passes; voip/unknown rejected.
 */
export function surfaceAllows(surface: TargetSurface, lineType: LineType, consent: ConsentSnapshot): { ok: boolean; reason?: string } {
  if (lineType === "landline") return { ok: true };
  if (surface === "landline_only") return { ok: false, reason: `line_type=${lineType} rejected under landline_only` };
  if (lineType === "wireless") return hasActiveGrant(consent) ? { ok: true } : { ok: false, reason: "wireless without active CONSENT_EVENT(grant)" };
  return { ok: false, reason: `line_type=${lineType} not dialable` };
}
