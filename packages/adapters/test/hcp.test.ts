import { afterEach, describe, expect, it, vi } from "vitest";
import { createHcpAdapter, idempotencyTag, mapJob, mapWindows } from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const q = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe("hcp real adapter — shapes observed live on 2026-09-13", () => {
  it("lists employees across every page with Bearer auth and page_size 200", async () => {
    const calls = stubFetch((c) => {
      const page = Number(q(c.url).page);
      return { json: { page, page_size: 200, total_pages: 2, total_items: 3, employees: page === 1
        ? [{ id: "pro_a", first_name: "Pedro", last_name: "Becerra", role: "field tech" }, { id: "pro_b", first_name: "Joseph", last_name: "McGrew" }]
        : [{ id: "pro_c", first_name: "Keisha", last_name: "Brown" }] } };
    });
    const h = createHcpAdapter(realConfig({ HCP_API_KEY: "k" }));
    expect(h.mode).toBe("real");
    const out = await h.listEmployees();
    expect(out.map((e) => e.id)).toEqual(["pro_a", "pro_b", "pro_c"]);
    expect(out[0]).toEqual({ id: "pro_a", first_name: "Pedro", last_name: "Becerra", role: "field tech" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.startsWith("https://api.housecallpro.com/employees?")).toBe(true);
    expect(q(calls[0]!.url)).toMatchObject({ page: "1", page_size: "200" });
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
  });

  it("lists jobs with the verified scheduled_start_min/max filters and maps schedule, employees and address", async () => {
    const calls = stubFetch(() => ({ json: { page: 1, total_pages: 1, jobs: [
      { id: "job_1", work_status: "scheduled", tags: [], assigned_employees: [{ id: "pro_a" }, { id: "pro_b" }],
        schedule: { scheduled_start: "2026-09-14T13:00:00Z", scheduled_end: "2026-09-14T18:00:00Z", arrival_window: 120 },
        address: { street: "2632 Woodacres Rd NE", city: "Atlanta", state: "GA", zip: "30345", latitude: 33.8635, longitude: -84.3016 } },
      { id: "job_2", work_status: "pro canceled", schedule: { scheduled_start: "2026-09-14T13:00:00Z", scheduled_end: "2026-09-14T15:00:00Z" }, assigned_employees: [] },
      { id: "job_3", work_status: "scheduled", deleted_at: "2026-09-01T00:00:00Z", schedule: { scheduled_start: "2026-09-14T13:00:00Z", scheduled_end: "2026-09-14T15:00:00Z" } },
      { id: "job_4", work_status: "scheduled", schedule: null },
    ] } }));
    const jobs = await createHcpAdapter(realConfig({ HCP_API_KEY: "k" })).listJobs({ start: "2026-09-13T00:00:00.000Z", end: "2026-09-27T00:00:00.000Z" });
    expect(q(calls[0]!.url)).toMatchObject({ scheduled_start_min: "2026-09-13T00:00:00.000Z", scheduled_start_max: "2026-09-27T00:00:00.000Z" });
    expect(jobs).toEqual([{
      id: "job_1", employee_ids: ["pro_a", "pro_b"], scheduled_start: "2026-09-14T13:00:00Z", scheduled_end: "2026-09-14T18:00:00Z", arrival_window_minutes: 120,
      address: { street: "2632 Woodacres Rd NE", city: "Atlanta", state: "GA", zip: "30345", lat: 33.8635, lon: -84.3016 }, work_status: "scheduled",
    }]);
  });

  it("drops canceled, deleted and unscheduled jobs so they never block a technician", () => {
    const base = { id: "j", schedule: { scheduled_start: "2026-09-14T13:00:00Z", scheduled_end: "2026-09-14T15:00:00Z" } };
    expect(mapJob({ ...base, work_status: "scheduled" })?.id).toBe("j");
    expect(mapJob({ ...base, work_status: "pro canceled" })).toBeNull();
    expect(mapJob({ ...base, work_status: "scheduled", canceled_at: "x" })).toBeNull();
    expect(mapJob({ ...base, work_status: "scheduled", deleted_at: "x" })).toBeNull();
    expect(mapJob({ id: "j", work_status: "scheduled", schedule: null })).toBeNull();
  });

  it("maps company schedule_availability day names to day_of_week and keeps only days with windows", () => {
    const out = mapWindows({ daily_availabilities: { data: [
      { day_name: "friday", schedule_windows: { data: [{ start_time: "08:00", end_time: "16:00" }] } },
      { day_name: "saturday", schedule_windows: { data: [] } },
      { day_name: "monday", schedule_windows: { data: [{ start_time: "08:00", end_time: "16:00" }] } },
      { day_name: "someday", schedule_windows: { data: [{ start_time: "09:00", end_time: "10:00" }] } },
    ] } });
    expect(out).toEqual([{ day_of_week: 5, start: "08:00", end: "16:00" }, { day_of_week: 1, start: "08:00", end: "16:00" }]);
  });

  describe("createJob", () => {
    const input = {
      customer_id: "cus_1", address_id: "adr_1", description: "Booked by voice agent for Dana Reyes",
      scheduled_start: "2026-09-20T13:00:00.000Z", arrival_window_in_minutes: 120, employee_ids: ["pro_a"], idempotency_key: "bk_123",
    };
    it("returns the existing job when one already carries the idempotency tag, without POSTing", async () => {
      const calls = stubFetch(() => ({ json: { page: 1, total_pages: 1, jobs: [{ id: "job_prev", tags: [idempotencyTag("bk_123")], schedule: { scheduled_start: "2026-09-20T13:00:00Z", scheduled_end: "2026-09-20T15:00:00Z" } }] } }));
      await expect(createHcpAdapter(realConfig({ HCP_API_KEY: "k" })).createJob(input)).resolves.toEqual({ id: "job_prev" });
      expect(calls.every((c) => c.method === "GET")).toBe(true);
      // The scan window brackets the scheduled start by a day on each side.
      expect(q(calls[0]!.url)).toMatchObject({ scheduled_start_min: "2026-09-19T13:00:00.000Z", scheduled_start_max: "2026-09-21T13:00:00.000Z" });
    });
    it("creates the job with the field names HCP itself returns, and the tag for next time", async () => {
      const calls = stubFetch((c) => c.method === "POST" ? { status: 201, json: { id: "job_new" } } : { json: { page: 1, total_pages: 1, jobs: [] } });
      await expect(createHcpAdapter(realConfig({ HCP_API_KEY: "k" })).createJob(input)).resolves.toEqual({ id: "job_new" });
      const post = calls.find((c) => c.method === "POST")!;
      expect(post.url).toBe("https://api.housecallpro.com/jobs");
      expect(JSON.parse(post.body!)).toEqual({
        customer_id: "cus_1", address_id: "adr_1",
        schedule: { scheduled_start: "2026-09-20T13:00:00.000Z", scheduled_end: "2026-09-20T15:00:00.000Z", arrival_window: 120 },
        assigned_employee_ids: ["pro_a"], notes: "Booked by voice agent for Dana Reyes", tags: ["tm-voice:bk_123"], lead_source: "TM Voice agent",
      });
    });
    it("refuses without a customer id before any network call — every HCP job belongs to a customer", async () => {
      const calls = stubFetch(() => ({ json: {} }));
      const { customer_id: _c, ...noCustomer } = input;
      await expect(createHcpAdapter(realConfig({ HCP_API_KEY: "k" })).createJob(noCustomer)).rejects.toMatchObject({ code: "customer_required", retryable: false });
      expect(calls).toHaveLength(0);
    });
    it("fails loudly when the create response carries no id", async () => {
      stubFetch((c) => c.method === "POST" ? { status: 201, json: {} } : { json: { page: 1, total_pages: 1, jobs: [] } });
      await expect(createHcpAdapter(realConfig({ HCP_API_KEY: "k" })).createJob(input)).rejects.toMatchObject({ code: "missing_job_id" });
    });
  });

  it("fails closed on webhooks until a signing secret exists", () => {
    expect(createHcpAdapter(realConfig({ HCP_API_KEY: "k" })).verifyWebhook("sig", "{}")).toBe(false);
  });

  it("healthcheck reports the company name on success", async () => {
    stubFetch(() => ({ json: { id: "co_1", name: "Transparent Maintenance" } }));
    await expect(createHcpAdapter(realConfig({ HCP_API_KEY: "k" })).healthcheck()).resolves.toEqual({ vendor: "hcp", ok: true, mode: "real", detail: "Transparent Maintenance" });
  });
});
