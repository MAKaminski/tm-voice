import type { Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, notImplemented, useMock, validate } from "../base.js";

export interface HcpEmployee { id: string; first_name: string; last_name: string; role?: string }
export interface HcpJob {
  id: string; employee_ids: string[]; scheduled_start: string; scheduled_end: string; arrival_window_minutes: number;
  address?: { street: string; city?: string; state?: string; zip?: string; lat?: number; lon?: number };
  work_status: string;
}
export interface HcpScheduleWindow { day_of_week: number; start: string; end: string }

export const createJobInput = z.object({
  customer_id: z.string().optional(),
  address_id: z.string().optional(),
  description: z.string(),
  scheduled_start: z.string().datetime(),
  arrival_window_in_minutes: z.number().int().positive(),
  employee_ids: z.array(z.string()).min(1),
  /** Used as HCP invoice_number so retries are idempotent. */
  invoice_number: z.string(),
});
export type CreateJobInput = z.infer<typeof createJobInput>;

export interface HcpAdapter extends Adapter {
  listEmployees(): Promise<HcpEmployee[]>;
  listJobs(range: { start: string; end: string }): Promise<HcpJob[]>;
  getScheduleWindows(): Promise<HcpScheduleWindow[]>;
  createJob(input: CreateJobInput): Promise<{ id: string }>;
  verifyWebhook(signature: string | undefined, rawBody: string): boolean;
}

/** Mock fixtures mirror packages/db seed so the availability materializer runs end-to-end without a key. */
export interface HcpMockState { employees: HcpEmployee[]; jobs: HcpJob[]; windows: HcpScheduleWindow[] }
function easternIso(day: Date, hh: number): string {
  const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(Date.UTC(y, m, d, 12)));
  const off = Number((parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5").replace("GMT", "")) || -5;
  return new Date(Date.UTC(y, m, d, hh - off)).toISOString();
}
/** Same three techs and three jobs as packages/db seed, dated tomorrow. */
export function mockJobsFor(day = new Date(Date.now() + 86_400_000)): HcpJob[] {
  const j = (id: string, emp: string, hh: number, lat: number, lon: number): HcpJob => ({
    id, employee_ids: [emp], scheduled_start: easternIso(day, hh), scheduled_end: easternIso(day, hh + 2), arrival_window_minutes: 120,
    address: { street: "mock", lat, lon }, work_status: "scheduled",
  });
  return [
    j("job_p1", "emp_pedro", 8, 33.7838, -84.383),
    j("job_k1", "emp_keisha", 8, 33.9526, -84.5499),
    j("job_k2", "emp_keisha", 13, 33.9526, -84.5499),
    j("job_l1", "emp_luis", 10, 33.9519, -83.3576),
  ];
}
export const defaultHcpMockState = (): HcpMockState => ({
  employees: [
    { id: "emp_pedro", first_name: "Pedro", last_name: "Alvarez" },
    { id: "emp_keisha", first_name: "Keisha", last_name: "Brown" },
    { id: "emp_luis", first_name: "Luis", last_name: "Ortega" },
  ],
  jobs: mockJobsFor(),
  windows: [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start: "08:00", end: "17:00" })),
});

export function createHcpAdapter(cfg: Config, state: HcpMockState = defaultHcpMockState()): HcpAdapter & { mock?: MockRecorder; state?: HcpMockState } {
  if (useMock(cfg, "HCP_API_KEY")) {
    const mock = new MockRecorder();
    const created = new Map<string, string>();
    return {
      name: "hcp", mode: "mock", mock, state,
      async healthcheck() { return { vendor: "hcp", ok: true, mode: "mock" as const }; },
      async listEmployees() { mock.record("listEmployees"); return state.employees; },
      async listJobs(range) {
        mock.record("listJobs", range);
        return state.jobs.filter((j) => j.scheduled_start >= range.start && j.scheduled_start <= range.end);
      },
      async getScheduleWindows() { mock.record("getScheduleWindows"); return state.windows; },
      async createJob(input) {
        const v = validate("hcp", createJobInput, input);
        mock.record("createJob", v);
        const id = created.get(v.invoice_number) ?? `mock_job_${created.size + 1}`;
        created.set(v.invoice_number, id);
        return { id };
      },
      verifyWebhook() { return true; },
    };
  }
  return {
    name: "hcp", mode: "real",
    async healthcheck() {
      // Docs are inconsistent between `Bearer` and `Token`; RUNBOOK asks Michael to confirm. Try Bearer first.
      const r = await fetch("https://api.housecallpro.com/company", { headers: { Authorization: `Bearer ${cfg.HCP_API_KEY!}`, Accept: "application/json" } });
      return { vendor: "hcp", ok: r.ok, mode: "real", detail: r.ok ? undefined : `HTTP ${r.status} (try Token scheme)` };
    },
    async listEmployees() { return notImplemented("hcp", "listEmployees"); },
    async listJobs() { return notImplemented("hcp", "listJobs"); },
    async getScheduleWindows() { return notImplemented("hcp", "getScheduleWindows"); },
    async createJob() { return notImplemented("hcp", "createJob"); },
    verifyWebhook() { return notImplemented("hcp", "verifyWebhook"); },
  };
}
