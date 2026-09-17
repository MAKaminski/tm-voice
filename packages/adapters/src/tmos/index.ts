import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, request, useMock, validate } from "../base.js";

/**
 * TM-OS is the Transparent Maintenance board (tm-os-makaminski1337.vercel.app). Its tables live in
 * the `ops` schema of the SAME Supabase project as tm-voice's own `agents` schema (uzvbzusomftegypxudbj,
 * "TM1") — one database, two schemas, two owners. It is still reached over PostgREST as a vendor,
 * never through drizzle and never by adding it to packages/db: one drizzle schema spanning both
 * would put another team's board inside this repo's migration blast radius.
 *
 * (Corrected 2026-09-17. This comment and the env said a different project; that project does not
 * exist on the account. Nothing had failed because the adapter is a mock until the key is set.)
 *
 * Idempotency is `external_key`, NOT `source`. `source` on that table is an existing low-cardinality
 * label ("manual", "process", "claude", "discord") shared by dozens of rows, so it cannot carry a
 * unique constraint. See docs/RUNBOOK.md for the one-time DDL that adds external_key.
 */
export const TASK_OWNER_CLAUDE = "Claude";
export const DEFAULT_ROLE = "Task Intake";

/**
 * The board's status vocabulary, read from the live data on 2026-09-17: inbox, next, blocked, done,
 * dropped. There is no "open" status, so a card filed as one would land in a state the board's own
 * columns do not render. New commitments arrive in `inbox`, which is the intake bucket and the
 * counterpart to the Task Intake role.
 */
export const STATUS_NEW = "inbox";

export interface TmosRole { id: string; name: string; owner: string; active: boolean }

/**
 * What the voice agent is allowed to say about the company (TM-OS decision 0031). Two tables, one
 * purpose: `ops.licences` are the numbers that expire, `ops.company_facts` the ones that do not.
 *
 * Only `sayable` rows are returned. The gate lives in TM-OS rather than here because it is a
 * business decision — a licence number read to a prospect is a claim the company is making — and a
 * person must be able to revoke it without a deploy.
 */
export interface TmosLicence {
  kind: string; name: string; number: string; holder: string;
  /** ISO date, or null for a registration number that does not expire. */
  expires_on: string | null;
}
export interface TmosFact { key: string; label: string; value: string }
export interface TmosCompanyFacts { licences: TmosLicence[]; facts: TmosFact[] }
export interface TmosTask { id: string; title: string; status: string; owner: string; source: string | null; external_key: string | null }

export const createTaskInput = z.object({
  title: z.string().min(1),
  owner: z.string().min(1).default(TASK_OWNER_CLAUDE),
  role: z.string().min(1).default(DEFAULT_ROLE),
  status: z.string().min(1).default(STATUS_NEW),
  source: z.string().min(1).default("vc"),
  /** `vc:<session_id>:<n>` — the unique key a replay collides on. */
  external_key: z.string().min(1),
  notes: z.string().default(""),
});
export type CreateTaskInput = z.input<typeof createTaskInput>;

export interface TmosAdapter extends Adapter {
  listRoles(): Promise<TmosRole[]>;
  /** Open tasks only — the extractor uses these to avoid filing something already on the board. */
  listOpenTasks(): Promise<TmosTask[]>;
  /** Idempotent on external_key: a row that already exists is returned, never duplicated. */
  createTask(input: CreateTaskInput): Promise<{ id: string; created: boolean }>;
  /** Sayable company facts for the assistant's system prompt. Expiry is filtered by the caller, not here. */
  listCompanyFacts(): Promise<TmosCompanyFacts>;
}

/** Not yet finished: what the extractor must not file a second time. */
const STATUSES_OPEN = ["inbox", "next", "blocked"] as const;

export function createTmosAdapter(cfg: Config): TmosAdapter & { mock?: MockRecorder; tasks?: Map<string, TmosTask> } {
  if (useMock(cfg, "TMOS_SUPABASE_URL", "TMOS_SERVICE_KEY")) {
    const mock = new MockRecorder();
    const tasks = new Map<string, TmosTask>();
    return {
      name: "tmos", mode: "mock", mock, tasks,
      async healthcheck() { return { vendor: "tmos", ok: true, mode: "mock" as const }; },
      async listRoles() {
        mock.record("listRoles");
        return MOCK_ROLES.map((r) => ({ ...r }));
      },
      async listOpenTasks() {
        mock.record("listOpenTasks");
        return [...tasks.values()].filter((t) => (STATUSES_OPEN as readonly string[]).includes(t.status));
      },
      async createTask(input) {
        const v = validate("tmos", createTaskInput, input);
        mock.record("createTask", v);
        const existing = tasks.get(v.external_key);
        if (existing) return { id: existing.id, created: false };
        const row: TmosTask = {
          id: `mock_task_${tasks.size + 1}`, title: v.title, status: v.status,
          owner: v.owner, source: v.source, external_key: v.external_key,
        };
        tasks.set(v.external_key, row);
        return { id: row.id, created: true };
      },
      async listCompanyFacts() {
        mock.record("listCompanyFacts");
        return { licences: MOCK_LICENCES.map((l) => ({ ...l })), facts: MOCK_FACTS.map((f) => ({ ...f })) };
      },
    };
  }

  const base = `${cfg.TMOS_SUPABASE_URL!.replace(/\/$/, "")}/rest/v1`;
  // Accept-Profile / Content-Profile select the `ops` schema; without them PostgREST answers on public.
  const headers = (write: boolean) => ({
    apikey: cfg.TMOS_SERVICE_KEY!,
    authorization: `Bearer ${cfg.TMOS_SERVICE_KEY!}`,
    ...(write ? { "content-profile": "ops" } : { "accept-profile": "ops" }),
  });

  return {
    name: "tmos", mode: "real",
    async healthcheck() {
      const r = await fetch(`${base}/roles?select=id&limit=1`, { headers: headers(false) });
      if (r.ok) return { vendor: "tmos", ok: true, mode: "real" };
      return { vendor: "tmos", ok: false, mode: "real", detail: `HTTP ${r.status}` };
    },
    async listRoles() {
      return request<TmosRole[]>({
        vendor: "tmos", url: `${base}/roles`, headers: headers(false),
        query: { select: "id,name,owner,active", active: "eq.true" },
      });
    },
    async listOpenTasks() {
      return request<TmosTask[]>({
        vendor: "tmos", url: `${base}/tasks`, headers: headers(false),
        query: { select: "id,title,status,owner,source,external_key", status: `in.(${STATUSES_OPEN.join(",")})` },
      });
    },
    async createTask(input) {
      const v = validate("tmos", createTaskInput, input);
      // merge-duplicates on the external_key unique index makes the insert itself idempotent, so a
      // replayed job cannot file the same commitment twice even if it races another worker.
      const rows = await request<TmosTask[]>({
        vendor: "tmos", method: "POST", url: `${base}/tasks`,
        headers: { ...headers(true), prefer: "return=representation,resolution=merge-duplicates" },
        query: { on_conflict: "external_key" },
        body: [{
          title: v.title, owner: v.owner, role: v.role, status: v.status,
          source: v.source, external_key: v.external_key, notes: v.notes,
        }],
      });
      const row = rows[0];
      if (!row?.id) throw new AdapterError({ vendor: "tmos", code: "missing_task_id", retryable: false, raw: rows });
      return { id: row.id, created: true };
    },
    async listCompanyFacts() {
      const [licences, facts] = await Promise.all([
        request<TmosLicence[]>({
          vendor: "tmos", url: `${base}/licences`, headers: headers(false),
          query: { select: "kind,name,number,holder,expires_on", sayable: "is.true", order: "sort" },
        }),
        request<TmosFact[]>({
          vendor: "tmos", url: `${base}/company_facts`, headers: headers(false),
          query: { select: "key,label,value", sayable: "is.true", order: "sort" },
        }),
      ]);
      return { licences, facts };
    },
  };
}

/** Seeded sayable rows, mirroring the live board so a dry_run prompt has the shape a live one will. */
export const MOCK_LICENCES: TmosLicence[] = [
  { kind: "general_contractor", name: "Georgia general contractor — company", number: "RBCO007813", holder: "Transparent Maintenance", expires_on: "2030-06-30" },
  { kind: "lead_safe_firm", name: "Georgia certified lead-based paint renovation firm", number: "GA-EPD-RRP FIRM-398659", holder: "Transparent Maintenance Inc.", expires_on: "2026-12-14" },
  { kind: "lead_safe_renovator", name: "Georgia certified renovator", number: "GA-EPD-RRP-8813-5041", holder: "Joseph McGrew", expires_on: "2027-02-23" },
  { kind: "registration", name: "Georgia Secretary of State control number", number: "22027249", holder: "Transparent Maintenance", expires_on: null },
];
export const MOCK_FACTS: TmosFact[] = [
  { key: "address", label: "Business address", value: "180 East Knight Rd, McDonough, GA 30252" },
  { key: "capacity", label: "Crews", value: "Maintenance: 2 technicians. Turns: 2 crews. Renovations: 2 crews." },
  { key: "subcontracted", label: "Subcontracted trades", value: "Plumbing, electrical, HVAC, roofing, framing, painting, concrete, drywall, siding replacement." },
  { key: "work_orders", label: "Work orders", value: "wo@transparentmaintenance.com" },
];

/** The roles seeded on the live board, as of 2026-09-17. Used by the mock and by role resolution. */
export const MOCK_ROLES: TmosRole[] = [
  { id: "1c976f3b-ee69-428f-8ff0-0ffccad1a0b2", name: "Call Desk Rep", owner: "Unassigned", active: true },
  { id: "b34cd41c-59af-42d3-a4fc-7152a6eac717", name: "Compliance & Insurance", owner: "James", active: true },
  { id: "16b980eb-c2b5-489d-9910-7c9451f455b8", name: "Consumer Growth", owner: "Zach", active: true },
  { id: "b7fa5e81-bb72-4c2c-a93b-37ef9f339be4", name: "Reporting & Ops Review", owner: "Michael", active: true },
  { id: "d0662e8a-2470-41db-8c12-092a8c84bc61", name: "Task Intake", owner: "Claude", active: true },
  { id: "66662e8a-69e7-4c55-b1a8-08675bcdce68", name: "Vendor Onboarding", owner: "Michael", active: true },
  { id: "9b796bf9-aeb6-470d-8beb-e7d98527c98d", name: "Voice Bot Build", owner: "Michael", active: true },
];
