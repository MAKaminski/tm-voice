import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapters } from "@tm/adapters";
import { createProducer } from "@tm/api";
import { call, callTask, seed, SEED } from "@tm/db";
import { createTestDb } from "@tm/db/test";
import { loadConfig } from "@tm/shared";
import type { Ctx } from "../src/context.js";
import { dialClaim, dialTick } from "../src/processors/dial.js";
import { retentionSweep } from "../src/processors/retention.js";

const cfg = loadConfig({ DATABASE_URL: "x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });
let t: Awaited<ReturnType<typeof createTestDb>>;
let r: Awaited<ReturnType<typeof seed>>;
let ctx: Ctx;
const enqueued: string[] = [];
const envelope = { entity_id: "x", idempotency_key: "k", attempt: 0, enqueued_at: new Date().toISOString() };

// The gate's calling-window check uses wall-clock `now`; outside 08:00–21:00 ET the outcome is legitimately 'window'.
const inWindow = () => { const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())) % 24; return h >= 8 && h < 21; };

beforeAll(async () => {
  t = await createTestDb();
  r = await seed(t.db);
  ctx = { cfg, db: t.db, adapters: createAdapters(cfg), producer: createProducer(undefined, async (q, n) => { enqueued.push(`${q}.${n}`); }) };
  await t.db.update(callTask).set({ earliestDialAt: new Date("2099-01-01") });
  const dana = r.contacts.find((x) => x.phoneE164 === SEED.phones.landlineGa)!;
  const marcus = r.contacts.find((x) => x.phoneE164 === SEED.phones.wirelessGa)!;
  await t.db.update(callTask).set({ earliestDialAt: new Date("2020-01-01") }).where(eq(callTask.contactId, dana.id));
  await t.db.update(callTask).set({ earliestDialAt: new Date("2020-01-02") }).where(eq(callTask.contactId, marcus.id));
});
afterAll(() => t.close());

describe("dial.claim in dry_run", () => {
  it("landline passes the gate and records a synthetic CALL with disposition=dry_run", async () => {
    const out = (await dialClaim(ctx, { ...envelope })) as { call_id?: string; gate_result?: string; synthetic?: boolean };
    if (!inWindow()) { expect(out.gate_result).toBe("window"); return; }
    expect(out.gate_result).toBe("pass");
    expect(out.synthetic).toBe(true);
    const [c] = await t.db.select().from(call).where(eq(call.id, out.call_id!));
    expect(c?.disposition).toBe("dry_run");
    expect(c?.vapiCallId).toMatch(/^dryrun_/);
    expect(ctx.adapters.vapi.mock?.calls).toHaveLength(1);
  });
  it("wireless is rejected with gate_result=surface and no CALL is created", async () => {
    const out = (await dialClaim(ctx, { ...envelope })) as { gate_result?: string };
    expect(out.gate_result).toBe("surface"); // surface check precedes the window check, so this holds at any hour
    const marcus = r.contacts.find((x) => x.phoneE164 === SEED.phones.wirelessGa)!;
    const [task] = await t.db.select().from(callTask).where(eq(callTask.contactId, marcus.id));
    expect(task?.gateResult).toBe("surface");
    expect(task?.status).toBe("blocked");
    expect(ctx.adapters.vapi.mock?.calls.length).toBeLessThanOrEqual(1);
  });
  it("dial.tick enqueues one claim per active campaign under cap", async () => {
    const out = (await dialTick(ctx, envelope)) as { enqueued: number };
    expect(out.enqueued).toBe(1);
    expect(enqueued).toContain("dial.claim");
  });
  it("retention sweep purges nothing when nothing is past retain_until", async () => {
    expect(await retentionSweep(ctx, envelope)).toEqual({ purged: 0 });
  });
});
