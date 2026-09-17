import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { booking, seed, SEED, suppression } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import { createApp } from "../src/app.js";
import { createProducer } from "../src/queue.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123", NODE_ENV: "test" });
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
let app: ReturnType<typeof createApp>;
const enqueued: string[] = [];
beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db, { day: new Date(Date.now() + 86_400_000) });
  app = createApp({ cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async (q, n) => { enqueued.push(`${q}.${n}`); }) });
});
afterAll(() => t.close());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const auth = { authorization: `Bearer ${cfg.INTERNAL_API_TOKEN}` };

describe("api", () => {
  it("GET /health reports 8 mocked vendors in dry_run", async () => {
    const res = await app.request("/health");
    const j = await json(res);
    expect(res.status).toBe(200);
    expect(j.dial_mode).toBe("dry_run");
    expect(j.dnc_scrub).toBe("required");
    expect(j.vendors).toHaveLength(8);
    expect(j.vendors.every((v: { mode: string }) => v.mode === "mock")).toBe(true);
  });
  it("GET /availability requires the internal token", async () => {
    expect((await app.request(`/availability?service_address_id=${r.addresses.buckhead.id}`)).status).toBe(401);
    const res = await app.request(`/availability?service_address_id=${r.addresses.buckhead.id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect((await json(res)).slots.length).toBeGreaterThan(0);
  });
  it("booking page: invalid token 404, valid token returns slots, booking lands as pending_review", async () => {
    expect((await app.request("/book/nope")).status).toBe(404);
    const page = await json(await app.request(`/book/${SEED.bookingToken}`));
    expect(page.contact.first_name).toBe("Dana");
    const slot = page.slots[0];
    const res = await app.request(`/book/${SEED.bookingToken}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ technician_id: slot.technician_id, service_address_id: page.addresses[0].id, window_start: slot.window_start }),
    });
    expect(res.status).toBe(201);
    const { booking: b } = await json(res);
    expect(b.status).toBe("pending_review");
    // idempotent re-post
    const again = await app.request(`/book/${SEED.bookingToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ technician_id: slot.technician_id, service_address_id: page.addresses[0].id, window_start: slot.window_start }) });
    expect(again.status).toBe(200);
    expect((await json(again)).booking.id).toBe(b.id);
    // approve → fans out hcp/graph/resend jobs
    const rev = await app.request(`/bookings/${b.id}/review`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ decision: "approve", reviewed_by: "michael" }) });
    expect(rev.status).toBe(200);
    expect(enqueued.sort()).toEqual(["graph.createEvent", "hcp.createJob", "resend.sendPacket"]);
    const [row] = await t.db.select().from(booking).where(eq(booking.id, b.id));
    expect(row?.status).toBe("approved");
  });
  it("POST /tools/opt_out rejects a bad signature and suppresses on a good one", async () => {
    const body = JSON.stringify({ message: { type: "tool-calls", call: { id: "call_1", customer: { number: SEED.phones.landlineGa } }, toolCalls: [{ id: "tc1", function: { name: "opt_out", arguments: { reason: "said stop" } } }] } });
    expect((await app.request("/tools/opt_out", { method: "POST", body, headers: { "x-vapi-secret": "wrong" } })).status).toBe(401);
    const sig = createHmac("sha256", "mock-vapi-secret").update(body).digest("hex");
    const res = await app.request("/tools/opt_out", { method: "POST", body, headers: { "x-vapi-signature": sig } });
    expect(res.status).toBe(200);
    expect((await json(res)).results[0].result).toMatch(/end the call/);
    const [s] = await t.db.select().from(suppression).where(eq(suppression.phoneE164, SEED.phones.landlineGa));
    expect(s).toBeDefined();
    // Every tool is implemented now, so a malformed Vapi envelope is a 400, never a 501.
    for (const tool of ["get_availability", "book_job", "send_packet"]) {
      expect((await app.request(`/tools/${tool}`, { method: "POST", body: "{}", headers: { "x-vapi-secret": "mock-vapi-secret" } })).status).toBe(400);
    }
  });
  it("POST /webhooks/hcp enqueues a materialize job", async () => {
    const res = await app.request("/webhooks/hcp", { method: "POST", body: JSON.stringify({ event: "job.scheduled", id: "job_x" }) });
    expect(res.status).toBe(200);
    expect(enqueued).toContain("availability.materialize");
  });
});

describe("PATCH /campaigns/:id — the stop-dialling switch", () => {
  it("requires the internal token", async () => {
    const res = await app.request(`/campaigns/${r.campaign.id}`, {
      method: "PATCH", body: JSON.stringify({ status: "paused" }), headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("pauses a campaign, which the gate then refuses to claim work for", async () => {
    const res = await app.request(`/campaigns/${r.campaign.id}`, {
      method: "PATCH", body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json", ...auth },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).campaign.status).toBe("paused");
  });

  it("resumes it again", async () => {
    const res = await app.request(`/campaigns/${r.campaign.id}`, {
      method: "PATCH", body: JSON.stringify({ status: "active" }),
      headers: { "content-type": "application/json", ...auth },
    });
    expect((await json(res)).campaign.status).toBe("active");
  });

  it("refuses a status the schema does not have", async () => {
    const res = await app.request(`/campaigns/${r.campaign.id}`, {
      method: "PATCH", body: JSON.stringify({ status: "on fire" }),
      headers: { "content-type": "application/json", ...auth },
    });
    expect(res.status).toBe(400);
  });

  it("404s on a campaign that does not exist", async () => {
    const res = await app.request("/campaigns/3f6d7d2a-1e6d-4c1b-9d3a-1f2e3d4c5b6a", {
      method: "PATCH", body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json", ...auth },
    });
    expect(res.status).toBe(404);
  });
});
