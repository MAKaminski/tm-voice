/**
 * TCPA/TSR calling window: 08:00–21:00 in the contact's local time.
 * State overrides: FL cutoff 20:00, CT start 09:00. Extend here, not in the gate.
 */
const DEFAULT = { start: 8, end: 21 };
const STATE_OVERRIDES: Record<string, Partial<typeof DEFAULT>> = { FL: { end: 20 }, CT: { start: 9 } };

export function windowFor(state: string | null | undefined) {
  return { ...DEFAULT, ...(state ? STATE_OVERRIDES[state.toUpperCase()] ?? {} : {}) };
}

export function localHourMinute(now: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { hour: get("hour") % 24, minute: get("minute") };
}

export function inCallingWindow(now: Date, timezone: string, state?: string | null): boolean {
  const w = windowFor(state);
  const { hour, minute } = localHourMinute(now, timezone);
  const t = hour + minute / 60;
  return t >= w.start && t < w.end;
}
