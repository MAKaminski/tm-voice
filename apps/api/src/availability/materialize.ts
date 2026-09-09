import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { HcpAdapter } from "@tm/adapters";
import { type AnyDb, scheduleBlock, technician } from "@tm/db";
import { logger } from "@tm/shared";

export const HORIZON_DAYS = 14;

/**
 * Pulls HCP employees, jobs and company windows for a 14-day horizon into SCHEDULE_BLOCK.
 * Replaces hcp_job and window blocks in the horizon; leaves pto untouched. Idempotent.
 */
export async function materialize(db: AnyDb, hcp: HcpAdapter, now = new Date()): Promise<{ technicians: number; jobs: number; windows: number }> {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + HORIZON_DAYS * 86_400_000);
  const [employees, jobs, windows] = await Promise.all([hcp.listEmployees(), hcp.listJobs({ start: start.toISOString(), end: end.toISOString() }), hcp.getScheduleWindows()]);

  return db.transaction(async (tx) => {
    // Upsert technicians by hcp_employee_id
    const techByEmp = new Map<string, string>();
    for (const e of employees) {
      const [existing] = await tx.select({ id: technician.id }).from(technician).where(eq(technician.hcpEmployeeId, e.id));
      if (existing) { techByEmp.set(e.id, existing.id); continue; }
      const [row] = await tx.insert(technician).values({ name: `${e.first_name} ${e.last_name}`.trim(), hcpEmployeeId: e.id }).returning({ id: technician.id });
      techByEmp.set(e.id, row!.id);
    }
    const techIds = [...techByEmp.values()];
    if (!techIds.length) return { technicians: 0, jobs: 0, windows: 0 };

    await tx.delete(scheduleBlock).where(and(
      inArray(scheduleBlock.technicianId, techIds), inArray(scheduleBlock.source, ["hcp_job", "window"]),
      gte(scheduleBlock.startAt, start), lt(scheduleBlock.startAt, end),
    ));

    const jobRows = jobs.flatMap((j) => j.employee_ids.map((emp) => techByEmp.get(emp)).filter((t): t is string => !!t).map((technicianId) => ({
      technicianId, source: "hcp_job" as const, hcpJobId: j.id, startAt: new Date(j.scheduled_start), endAt: new Date(j.scheduled_end),
      lat: j.address?.lat != null ? String(j.address.lat) : null, lon: j.address?.lon != null ? String(j.address.lon) : null,
    })));
    if (jobRows.length) await tx.insert(scheduleBlock).values(jobRows);

    // Company arrival windows → one window block per tech per day in horizon (ET business days).
    const windowRows: (typeof scheduleBlock.$inferInsert)[] = [];
    for (let d = 0; d < HORIZON_DAYS; d++) {
      const day = new Date(start.getTime() + d * 86_400_000);
      const dow = easternDow(day);
      for (const w of windows.filter((w) => w.day_of_week === dow)) {
        const [sh, sm] = w.start.split(":").map(Number); const [eh, em] = w.end.split(":").map(Number);
        for (const technicianId of techIds) windowRows.push({ technicianId, source: "window", startAt: eastern(day, sh!, sm), endAt: eastern(day, eh!, em) });
      }
    }
    if (windowRows.length) await tx.insert(scheduleBlock).values(windowRows);
    logger.info({ technicians: techIds.length, jobs: jobRows.length, windows: windowRows.length }, "availability materialized");
    return { technicians: techIds.length, jobs: jobRows.length, windows: windowRows.length };
  });
}

export function eastern(day: Date, hh: number, mm = 0): Date {
  const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(Date.UTC(y, m, d, 12)));
  const off = Number((parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5").replace("GMT", "")) || -5;
  return new Date(Date.UTC(y, m, d, hh - off, mm ?? 0));
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function easternDow(day: Date): number {
  return DOW.indexOf(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(day));
}
