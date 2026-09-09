export const GATE_RESULTS = ["pass", "surface", "suppressed", "dnc", "window", "did_cap", "attempts"] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

export const LINE_TYPES = ["wireless", "landline", "voip", "unknown"] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const DISPOSITIONS = [
  "dry_run", "booked", "callback", "not_interested", "opt_out", "voicemail", "no_answer", "busy", "failed", "wrong_number",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const BOOKING_STATUSES = ["pending_review", "approved", "rejected", "synced", "failed"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface LatLon { lat: number; lon: number }

export function haversineMiles(a: LatLon, b: LatLon): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function idempotencyKey(...parts: (string | number)[]): string {
  return parts.join(":");
}
