import type { Config } from "@tm/shared";
import { AdapterError, logger } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, request, useMock, validate } from "../base.js";

const API = "https://api.housecallpro.com";
/** Verified live: page_size 200 is honoured, 500 is rejected. */
const PAGE_SIZE = 200;

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
  /**
   * Our handle for the job, carried on the HCP job as a `tm-voice:<key>` tag. HCP assigns
   * invoice numbers itself and has no idempotency header, so before creating, the client scans
   * the day around `scheduled_start` for a job already carrying this tag and returns it instead.
   */
  idempotency_key: z.string().min(1),
});
export type CreateJobInput = z.infer<typeof createJobInput>;

export interface HcpAdapter extends Adapter {
  listEmployees(): Promise<HcpEmployee[]>;
  listJobs(range: { start: string; end: string }): Promise<HcpJob[]>;
  getScheduleWindows(): Promise<HcpScheduleWindow[]>;
  createJob(input: CreateJobInput): Promise<{ id: string }>;
  verifyWebhook(signature: string | undefined, rawBody: string): boolean;
}

export const idempotencyTag = (key: string) => `tm-voice:${key}`;

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

// ---- wire shapes, as observed against the live API on 2026-09-13 (not from docs) ----
interface Envelope { page?: number; page_size?: number; total_pages?: number; total_items?: number }
interface WireEmployee { id?: string; first_name?: string; last_name?: string; role?: string }
interface WireJob {
  id?: string; work_status?: string; canceled_at?: string | null; deleted_at?: string | null; tags?: string[];
  assigned_employees?: { id?: string }[];
  schedule?: { scheduled_start?: string; scheduled_end?: string; arrival_window?: number } | null;
  address?: { street?: string; city?: string; state?: string; zip?: string; latitude?: number; longitude?: number } | null;
}
interface WireAvailability {
  daily_availabilities?: { data?: { day_name?: string; schedule_windows?: { data?: { start_time?: string; end_time?: string }[] } }[] };
}
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function mapJob(j: WireJob): HcpJob | null {
  // A job with no schedule cannot block a technician; canceled and deleted jobs must not either.
  // Observed work_status values: scheduled · complete unrated · complete rated · pro canceled.
  if (!j.id || !j.schedule?.scheduled_start || !j.schedule.scheduled_end) return null;
  if (j.canceled_at || j.deleted_at || /cancel/i.test(j.work_status ?? "")) return null;
  const a = j.address ?? undefined;
  return {
    id: j.id,
    employee_ids: (j.assigned_employees ?? []).map((e) => e.id).filter((x): x is string => !!x),
    scheduled_start: j.schedule.scheduled_start,
    scheduled_end: j.schedule.scheduled_end,
    arrival_window_minutes: j.schedule.arrival_window ?? 0,
    ...(a?.street ? { address: { street: a.street, ...(a.city ? { city: a.city } : {}), ...(a.state ? { state: a.state } : {}), ...(a.zip ? { zip: a.zip } : {}), ...(a.latitude != null ? { lat: a.latitude } : {}), ...(a.longitude != null ? { lon: a.longitude } : {}) } } : {}),
    work_status: j.work_status ?? "unknown",
  };
}

export function mapWindows(res: WireAvailability): HcpScheduleWindow[] {
  const out: HcpScheduleWindow[] = [];
  for (const day of res.daily_availabilities?.data ?? []) {
    const dow = DAY_NAMES.indexOf((day.day_name ?? "").toLowerCase());
    if (dow < 0) continue;
    for (const w of day.schedule_windows?.data ?? []) {
      if (w.start_time && w.end_time) out.push({ day_of_week: dow, start: w.start_time, end: w.end_time });
    }
  }
  return out;
}

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
        const id = created.get(v.idempotency_key) ?? `mock_job_${created.size + 1}`;
        created.set(v.idempotency_key, id);
        return { id };
      },
      verifyWebhook() { return true; },
    };
  }

  // Verified live 2026-09-13 with a MAX-plan key: both `Bearer` and `Token` authenticate; Bearer is used.
  const auth = { authorization: `Bearer ${cfg.HCP_API_KEY!}` };

  /** Walks every page of a list endpoint. Envelope: { page, page_size, total_pages, total_items, <collection>: [] }. */
  async function paged<T>(path: string, collection: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const res = await request<Envelope & Record<string, unknown>>({ vendor: "hcp", url: `${API}${path}`, query: { ...query, page, page_size: PAGE_SIZE }, headers: auth });
      const items = (res?.[collection] as T[] | undefined) ?? [];
      out.push(...items);
      const total = res?.total_pages ?? 1;
      if (page >= total || items.length === 0) break;
    }
    return out;
  }

  let warnedNoWebhookSecret = false;
  return {
    name: "hcp", mode: "real",
    async healthcheck() {
      try {
        const r = await request<{ name?: string }>({ vendor: "hcp", url: `${API}/company`, headers: auth, retry: { attempts: 1 } });
        return { vendor: "hcp", ok: !!r?.name, mode: "real", detail: r?.name };
      } catch (e) {
        return { vendor: "hcp", ok: false, mode: "real", detail: e instanceof Error ? e.message : "company lookup failed" };
      }
    },
    async listEmployees() {
      const rows = await paged<WireEmployee>("/employees", "employees");
      return rows.filter((e): e is WireEmployee & { id: string } => !!e.id)
        .map((e) => ({ id: e.id, first_name: e.first_name ?? "", last_name: e.last_name ?? "", ...(e.role ? { role: e.role } : {}) }));
    },
    async listJobs(range) {
      // Filter names verified live: scheduled_start_min / scheduled_start_max narrow the result; unknown params are silently ignored.
      const rows = await paged<WireJob>("/jobs", "jobs", { scheduled_start_min: range.start, scheduled_start_max: range.end });
      return rows.map(mapJob).filter((j): j is HcpJob => j !== null);
    },
    async getScheduleWindows() {
      return mapWindows(await request<WireAvailability>({ vendor: "hcp", url: `${API}/company/schedule_availability`, headers: auth }));
    },
    async createJob(input) {
      const v = validate("hcp", createJobInput, input);
      if (!v.customer_id) {
        // Every HCP job belongs to a customer. Without account.hcp_customer_id there is nothing to attach it to;
        // say so precisely rather than surfacing a vendor 4xx.
        throw new AdapterError({ vendor: "hcp", code: "customer_required", retryable: false, message: "HCP jobs must belong to a customer; account.hcp_customer_id is not set" });
      }
      const tag = idempotencyTag(v.idempotency_key);
      const start = new Date(v.scheduled_start);
      const end = new Date(start.getTime() + v.arrival_window_in_minutes * 60_000);

      // Idempotency: a retry after a partial failure finds the job created last time by its tag.
      const dayBefore = new Date(start.getTime() - 86_400_000).toISOString();
      const dayAfter = new Date(start.getTime() + 86_400_000).toISOString();
      const existing = (await paged<WireJob>("/jobs", "jobs", { scheduled_start_min: dayBefore, scheduled_start_max: dayAfter }))
        .find((j) => j.id && !j.deleted_at && (j.tags ?? []).includes(tag));
      if (existing?.id) return { id: existing.id };

      // Body mirrors the field names HCP itself returns on GET /jobs. Not verifiable without creating a
      // job in the production field system, so a wrong field fails loudly as a vendor 4xx, never silently.
      const res = await request<{ id?: string }>({
        vendor: "hcp", method: "POST", url: `${API}/jobs`, headers: auth,
        body: {
          customer_id: v.customer_id,
          ...(v.address_id ? { address_id: v.address_id } : {}),
          schedule: { scheduled_start: start.toISOString(), scheduled_end: end.toISOString(), arrival_window: v.arrival_window_in_minutes },
          assigned_employee_ids: v.employee_ids,
          notes: v.description,
          tags: [tag],
          lead_source: "TM Voice agent",
        },
      });
      if (!res?.id) throw new AdapterError({ vendor: "hcp", code: "missing_job_id", retryable: false, raw: res });
      return { id: res.id };
    },
    verifyWebhook() {
      // No signing secret is configured for HCP yet (the header and HMAC scheme are only reported second-hand
      // as x-housecallpro-signature / HMAC-SHA256 hex over the raw body). Fail closed: the route answers 401
      // and the 15-minute materializer keeps availability fresh meanwhile.
      if (!warnedNoWebhookSecret) { warnedNoWebhookSecret = true; logger.warn("hcp: webhook signing not configured; /webhooks/hcp rejects every delivery until it is"); }
      return false;
    },
  };
}
