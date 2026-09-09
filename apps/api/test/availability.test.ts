import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { scheduleBlock, seed, SEED } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { computeSlots, materialize } from "../src/availability/index.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
const DAY = new Date("2026-09-10T00:00:00Z"); // Thursday
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => { t = await createTestDb(); r = await seed(t.db, { day: DAY }); });
afterAll(() => t.close());

const range = { earliest: new Date("2026-09-10T00:00:00Z"), latest: new Date("2026-09-12T00:00:00Z") };

describe("availability: slots from seeded techs/jobs", () => {
  it("returns ≤5 soonest slots, honoring the 2-jobs/day cap and the 50-mile rule for Buckhead", async () => {
    const slots = await computeSlots(t.db, { serviceAddressId: r.addresses.buckhead.id, ...range });
    expect(slots).toHaveLength(5);
    const daySlots = slots.filter((s) => s.day === "2026-09-10");
    // Keisha has 2 jobs (cap) and Luis is in Athens (~60 mi): only Pedro can serve Buckhead on 9/10
    expect(daySlots.every((s) => s.technician_id === r.technicians.pedro.id)).toBe(true);
    // Pedro's 08:00 job blocks the 08:00 slot; first offer is 10:00 ET = 14:00Z
    expect(daySlots[0]?.window_start).toBe("2026-09-10T14:00:00.000Z");
    expect(daySlots.map((s) => s.window_start)).toEqual(["2026-09-10T14:00:00.000Z", "2026-09-10T16:00:00.000Z", "2026-09-10T18:00:00.000Z"]);
  });
  it("Luis IS offerable for Buckhead the next day (no far job)", async () => {
    const slots = await computeSlots(t.db, { serviceAddressId: r.addresses.buckhead.id, earliest: new Date("2026-09-11T00:00:00Z"), latest: new Date("2026-09-12T00:00:00Z"), limit: 5 });
    expect(slots[0]?.window_start).toBe("2026-09-11T12:00:00.000Z");
  });
  it("a job >50 miles away removes that technician's day", async () => {
    // Move Pedro's job to Athens -> nobody can serve Buckhead on 9/10
    await t.db.update(scheduleBlock).set({ lat: String(SEED.athens.lat), lon: String(SEED.athens.lon) }).where(eq(scheduleBlock.hcpJobId, "job_p1"));
    const slots = await computeSlots(t.db, { serviceAddressId: r.addresses.buckhead.id, ...range });
    expect(slots.some((s) => s.day === "2026-09-10")).toBe(false);
    await t.db.update(scheduleBlock).set({ lat: String(SEED.atlantaMidtown.lat), lon: String(SEED.atlantaMidtown.lon) }).where(eq(scheduleBlock.hcpJobId, "job_p1"));
  });
  it("returns [] for an address without coordinates", async () => {
    const [row] = await t.db.select().from(scheduleBlock).limit(1);
    expect(row).toBeDefined();
    expect(await computeSlots(t.db, { serviceAddressId: "00000000-0000-0000-0000-000000000000", ...range })).toEqual([]);
  });
});

describe("materialize from the (mock) HCP adapter", () => {
  it("upserts technicians by hcp_employee_id and replaces job/window blocks idempotently", async () => {
    const { hcp } = createAdapters(cfg);
    const a = await materialize(t.db, hcp, new Date("2026-09-09T12:00:00Z"));
    const b = await materialize(t.db, hcp, new Date("2026-09-09T12:00:00Z"));
    expect(a.technicians).toBe(3);
    expect(b).toEqual(a);
    const jobs = await t.db.select().from(scheduleBlock).where(eq(scheduleBlock.source, "hcp_job"));
    expect(jobs.filter((j) => j.hcpJobId === "job_k1")).toHaveLength(1);
  });
});
