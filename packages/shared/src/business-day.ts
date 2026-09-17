/**
 * Where the dialer's "day" starts.
 *
 * The per-DID and per-campaign daily caps were counted from UTC midnight, which for an Atlanta
 * operation rolls the day over at 19:00 or 20:00 Eastern — in the middle of the calling window.
 * A 10-dial-per-day cap could therefore place 10 dials before 8pm and 10 more after it, i.e. 20
 * in one Eastern calendar day. A dial cap that does not mean what it says is worse than no cap,
 * because it is the number written down when the pilot's volume was agreed.
 *
 * The operating timezone is deliberately not the contact's. The caps are properties of the
 * business and its DIDs — how many calls *we* placed today — not of whoever we happened to call,
 * and counting a DID's usage in each callee's local day would make the cap unanswerable.
 */

/** The calling window and the caps are both Atlanta-local. Overridable via config for a second market. */
export const DEFAULT_DIAL_TIMEZONE = "America/New_York";

/**
 * Midnight at the start of `now`'s local day in `timeZone`, as a UTC instant.
 *
 * Derived through `Intl` rather than a fixed offset so it stays correct across the DST boundaries
 * that fall inside a campaign, instead of silently drifting by an hour twice a year.
 */
export function startOfLocalDay(now: Date, timeZone: string = DEFAULT_DIAL_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // How far into its local day `now` is; subtracting that from the instant lands on local midnight.
  const secondsIntoDay = at("hour") * 3_600 + at("minute") * 60 + at("second");
  const floored = new Date(Math.floor(now.getTime() / 1000) * 1000);
  return new Date(floored.getTime() - secondsIntoDay * 1000);
}
