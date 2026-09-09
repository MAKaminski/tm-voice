import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as s from "./schema.js";

export type AnyDb = PgDatabase<PgQueryResultHKT, typeof s.schema>;

export const DISCLOSURE_LINE =
  "Hi, this is an automated assistant using an artificial voice, calling on behalf of Transparent Maintenance about property maintenance services. This call is being recorded. You can say stop at any time to end the call and be removed from our list.";

/** Fixed fixture values so tests can assert on them. */
export const SEED = {
  atlantaMidtown: { lat: 33.7838, lon: -84.383 },
  marietta: { lat: 33.9526, lon: -84.5499 },
  decatur: { lat: 33.7748, lon: -84.2963 },
  buckhead: { lat: 33.84, lon: -84.38 },
  athens: { lat: 33.9519, lon: -83.3576 }, // ~60 mi from Midtown: the 50-mile outlier
  phones: {
    landlineGa: "+14045550100",
    wirelessGa: "+16785550101",
    landlineFl: "+13055550102",
    landlineCt: "+18605550103",
    landlineMa: "+16175550104",
    suppressed: "+14045550199",
    did: "+14045550000",
  },
  bookingToken: "seed-booking-token-0001",
} as const;

export interface SeedOptions {
  /** Local-date anchor for schedule blocks; default = tomorrow. Tests pass a fixed date. */
  day?: Date;
}

/** Returns a Date for `day` at HH:MM America/New_York. */
export function atEastern(day: Date, hh: number, mm = 0): Date {
  const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate();
  // Determine ET offset on that date (EDT -4 / EST -5) via Intl.
  const probe = new Date(Date.UTC(y, m, d, 12));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(probe);
  const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const hours = Number(off.replace("GMT", "")) || -5;
  return new Date(Date.UTC(y, m, d, hh - hours, mm));
}

export async function seed(db: AnyDb, opts: SeedOptions = {}) {
  const day = opts.day ?? new Date(Date.now() + 86_400_000);
  const dayAfter = new Date(day.getTime() + 86_400_000);

  const [script] = await db.insert(s.scriptVersion).values({
    name: "v1-atlanta-pm", disclosureLine: DISCLOSURE_LINE, body: "Ask about current maintenance vendor; offer a free walkthrough.", active: true,
  }).returning();
  const [camp] = await db.insert(s.campaign).values({
    name: "Atlanta PM pilot", scriptVersionId: script!.id, dailyDialCap: 10, maxAttempts: 3, status: "active",
  }).returning();

  const [acctA, acctB] = await db.insert(s.account).values([
    { name: "Peachtree Property Group", type: "property_mgr" },
    { name: "Buckhead Residential Mgmt", type: "property_mgr" },
  ]).returning();

  const [addrBuckhead, addrDecatur] = await db.insert(s.serviceAddress).values([
    { accountId: acctB!.id, line1: "3300 Peachtree Rd NE", city: "Atlanta", state: "GA", zip: "30305", lat: String(SEED.buckhead.lat), lon: String(SEED.buckhead.lon) },
    { accountId: acctA!.id, line1: "101 E Court Sq", city: "Decatur", state: "GA", zip: "30030", lat: String(SEED.decatur.lat), lon: String(SEED.decatur.lon) },
  ]).returning();

  const contacts = await db.insert(s.contact).values([
    { accountId: acctB!.id, firstName: "Dana", lastName: "Reyes", phoneE164: SEED.phones.landlineGa, lineType: "landline", state: "GA", timezone: "America/New_York", bookingToken: SEED.bookingToken, email: "dana@example.com" },
    { accountId: acctA!.id, firstName: "Marcus", lastName: "Lee", phoneE164: SEED.phones.wirelessGa, lineType: "wireless", state: "GA", timezone: "America/New_York" },
    { accountId: acctA!.id, firstName: "Priya", lastName: "Shah", phoneE164: SEED.phones.landlineFl, lineType: "landline", state: "FL", timezone: "America/New_York" },
    { accountId: acctA!.id, firstName: "Tom", lastName: "Nguyen", phoneE164: SEED.phones.landlineCt, lineType: "landline", state: "CT", timezone: "America/New_York" },
    { accountId: acctB!.id, firstName: "Erin", lastName: "Walsh", phoneE164: SEED.phones.landlineMa, lineType: "landline", state: "MA", timezone: "America/New_York" },
    { accountId: acctB!.id, firstName: "Sam", lastName: "Opted-Out", phoneE164: SEED.phones.suppressed, lineType: "landline", state: "GA", timezone: "America/New_York" },
  ]).returning();

  await db.insert(s.suppression).values({ phoneE164: SEED.phones.suppressed, reason: "seed: prior opt-out" });

  const [didRow] = await db.insert(s.did).values({ phoneE164: SEED.phones.did, dailyCap: 10, labelStatus: "unknown" }).returning();

  const [techA, techB, techC] = await db.insert(s.technician).values([
    { name: "Pedro Alvarez", hcpEmployeeId: "emp_pedro", homeLat: String(SEED.atlantaMidtown.lat), homeLon: String(SEED.atlantaMidtown.lon) },
    { name: "Keisha Brown", hcpEmployeeId: "emp_keisha", homeLat: String(SEED.marietta.lat), homeLon: String(SEED.marietta.lon) },
    { name: "Luis Ortega", hcpEmployeeId: "emp_luis", homeLat: String(SEED.decatur.lat), homeLon: String(SEED.decatur.lon) },
  ]).returning();

  const win = (techId: string, d: Date) => ({ technicianId: techId, source: "window" as const, startAt: atEastern(d, 8), endAt: atEastern(d, 17) });
  const job = (techId: string, d: Date, hh: number, at: { lat: number; lon: number }, hcpJobId: string) => ({
    technicianId: techId, source: "hcp_job" as const, startAt: atEastern(d, hh), endAt: atEastern(d, hh + 2), lat: String(at.lat), lon: String(at.lon), hcpJobId,
  });

  await db.insert(s.scheduleBlock).values([
    // Pedro: one job in Midtown tomorrow -> one slot left, within 50 mi of Buckhead
    win(techA!.id, day), job(techA!.id, day, 8, SEED.atlantaMidtown, "job_p1"),
    win(techA!.id, dayAfter),
    // Keisha: two jobs tomorrow -> at cap, no slot
    win(techB!.id, day), job(techB!.id, day, 8, SEED.marietta, "job_k1"), job(techB!.id, day, 13, SEED.marietta, "job_k2"),
    win(techB!.id, dayAfter),
    // Luis: one job in Athens tomorrow (>50 mi from Buckhead) -> excluded for Buckhead that day
    win(techC!.id, day), job(techC!.id, day, 10, SEED.athens, "job_l1"),
    win(techC!.id, dayAfter),
  ]);

  const tasks = await db.insert(s.callTask).values(
    contacts.map((c) => ({ campaignId: camp!.id, contactId: c.id })),
  ).returning();

  return {
    day, dayAfter, script: script!, campaign: camp!, accounts: [acctA!, acctB!], addresses: { buckhead: addrBuckhead!, decatur: addrDecatur! },
    contacts, did: didRow!, technicians: { pedro: techA!, keisha: techB!, luis: techC! }, tasks,
  };
}
