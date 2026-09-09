import { and, eq, gt, lt } from "drizzle-orm";
import { type AnyDb, scheduleBlock, serviceAddress, technician } from "@tm/db";
import { haversineMiles } from "@tm/shared";

export interface Slot {
  technician_id: string;
  technician_name: string;
  window_start: string;
  window_end: string;
  arrival_window_min: number;
  day: string;
}
export interface SlotQuery { serviceAddressId: string; earliest: Date; latest: Date; limit?: number; arrivalWindowMin?: number }

const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * The piece HCP doesn't provide. For each technician × day:
 *   - fewer than max_jobs_per_day hcp_job blocks, AND
 *   - every job that day within max_miles_between_jobs of the service address (haversine), AND
 *   - inside a window block, not overlapping a job.
 * Returns ≤ limit (default 5) soonest-first, one technician per start time.
 */
export async function computeSlots(db: AnyDb, q: SlotQuery): Promise<Slot[]> {
  const limit = q.limit ?? 5, arrival = q.arrivalWindowMin ?? 120;
  const [addr] = await db.select().from(serviceAddress).where(eq(serviceAddress.id, q.serviceAddressId));
  if (!addr || addr.lat == null || addr.lon == null) return [];
  const target = { lat: Number(addr.lat), lon: Number(addr.lon) };

  const techs = await db.select().from(technician).where(eq(technician.active, true));
  // Overlap semantics: a window that started before `earliest` still yields later slots.
  const blocks = await db.select().from(scheduleBlock).where(and(gt(scheduleBlock.endAt, q.earliest), lt(scheduleBlock.startAt, q.latest)));

  const out: Slot[] = [];
  for (const t of techs) {
    const byDay = new Map<string, (typeof blocks)[number][]>();
    for (const b of blocks.filter((b) => b.technicianId === t.id)) {
      const k = dayKey(b.startAt); byDay.set(k, [...(byDay.get(k) ?? []), b]);
    }
    for (const [day, dayBlocks] of byDay) {
      const jobs = dayBlocks.filter((b) => b.source === "hcp_job");
      if (jobs.length >= t.maxJobsPerDay) continue;
      const tooFar = jobs.some((j) => j.lat != null && j.lon != null && haversineMiles(target, { lat: Number(j.lat), lon: Number(j.lon) }) > t.maxMilesBetweenJobs);
      if (tooFar) continue;
      const busy = dayBlocks.filter((b) => b.source !== "window");
      for (const w of dayBlocks.filter((b) => b.source === "window")) {
        for (let s = w.startAt.getTime(); s + arrival * 60_000 <= w.endAt.getTime(); s += arrival * 60_000) {
          const e = s + arrival * 60_000;
          if (s < q.earliest.getTime()) continue;
          if (busy.some((b) => s < b.endAt.getTime() && e > b.startAt.getTime())) continue;
          out.push({ technician_id: t.id, technician_name: t.name, window_start: new Date(s).toISOString(), window_end: new Date(e).toISOString(), arrival_window_min: arrival, day });
        }
      }
    }
  }
  out.sort((a, b) => a.window_start.localeCompare(b.window_start));
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.window_start) ? false : (seen.add(s.window_start), true))).slice(0, limit);
}
