import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, request, useMock, validate } from "../base.js";

/**
 * TM-OS is the Transparent Maintenance board (tm-os-makaminski1337.vercel.app). Its tasks live in
 * `ops.tasks` in a DIFFERENT Supabase project from tm-voice's own Postgres — so it is reached over
 * PostgREST as a vendor, never through drizzle and never by adding it to packages/db. Two databases
 * in one drizzle schema would put the CRM inside the migration blast radius.
 *
 * Idempotency is `external_key`, NOT `source`. `source` on that table is an existing low-cardinality
 * label ("manual", "process", "claude", "discord") shared by dozens of rows, so it cannot carry a
 * unique constraint. See docs/RUNBOOK.md for the one-time DDL that adds external_key.
 */
export const TASK_OWNER_CLAUDE = "Claude";
export const DEFAULT_ROLE = "Task Intake";

export interface TmosRole { id: string; name: string; owner: string; active: boolean }
export interface TmosTask { id: string; title: string; status: string; owner: string; source: string | null; external_key: string | null }

export const createTaskInput = z.object({
  title: z.string().min(1),
  owner: z.string().min(1).default(TASK_OWNER_CLAUDE),
  role: z.string().min(1).default(DEFAULT_ROLE),
  status: z.string().min(1).default("open"),
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
}

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
  };
}

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
