import { AdapterError, loadConfig } from "@tm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_BYTE_LIMIT, createAdapters, createDiscordAdapter, createLlmAdapter, createSttBatchAdapter,
  createTmosAdapter, parseWatchChannelIds, setMockCompletion,
} from "../src/index.js";
import { realConfig, stubFetch } from "./helpers.js";

const dryRun = loadConfig({ DATABASE_URL: "postgres://x", INTERNAL_API_TOKEN: "0123456789abcdef0123" });

afterEach(() => vi.unstubAllGlobals());

describe("discord adapter", () => {
  it("refuses to post outside WATCH_CHANNEL_IDS", async () => {
    const a = createDiscordAdapter(loadConfig({
      DATABASE_URL: "postgres://x", INTERNAL_API_TOKEN: "0123456789abcdef0123", WATCH_CHANNEL_IDS: "111, 222",
    }));
    await expect(a.postChannelMessage({ channel_id: "999", content: "hi" }))
      .rejects.toMatchObject({ vendor: "discord", code: "channel_not_watched", retryable: false });
    await expect(a.postChannelMessage({ channel_id: "222", content: "hi" })).resolves.toMatchObject({ id: "mock_msg_1" });
  });

  it("parses the channel list tolerantly", () => {
    expect(parseWatchChannelIds(" 1, 2 ,,3 ")).toEqual(["1", "2", "3"]);
    expect(parseWatchChannelIds(undefined)).toEqual([]);
  });

  it("posts with mentions disabled so a notice never pings the room", async () => {
    const calls = stubFetch(() => ({ json: { id: "m1" } }));
    const a = createDiscordAdapter(realConfig({ WATCH_CHANNEL_IDS: "111" }));
    await a.postChannelMessage({ channel_id: "111", content: "recording" });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ allowed_mentions: { parse: [] } });
  });
});

describe("stt-batch adapter", () => {
  it("stays mock even in live mode with keys set, and says so", async () => {
    const a = createSttBatchAdapter(realConfig({ STT_BATCH_PROVIDER: "deepgram", STT_BATCH_API_KEY: "k" }));
    expect(a.mode).toBe("mock");
    const h = await a.healthcheck();
    expect(h.mode).toBe("mock");
    expect(h.detail).toContain("no client is implemented");
  });

  it("is deterministic on the key so a replay transcribes identically", async () => {
    const a = createSttBatchAdapter(dryRun);
    const input = { key: "meetings/s1/u1.opus", audio: new Uint8Array(8), content_type: "audio/ogg" };
    expect(await a.transcribeFile(input)).toEqual(await a.transcribeFile(input));
  });

  it("refuses an oversized request rather than silently truncating", async () => {
    const a = createSttBatchAdapter(dryRun);
    await expect(a.transcribeFile({ key: "k", audio: new Uint8Array(REQUEST_BYTE_LIMIT + 1), content_type: "audio/ogg" }))
      .rejects.toMatchObject({ vendor: "stt_batch", code: "payload_too_large", retryable: false });
  });
});

describe("tmos adapter", () => {
  it("dedupes on external_key, not on source", async () => {
    const a = createTmosAdapter(dryRun);
    const task = { title: "add a field for gate code", external_key: "vc:s1:1" };
    const first = await a.createTask(task);
    const second = await a.createTask({ ...task, title: "different title, same key" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(a.tasks?.size).toBe(1);
  });

  it("defaults to Claude / Task Intake / open / source vc", async () => {
    const a = createTmosAdapter(dryRun);
    await a.createTask({ title: "t", external_key: "vc:s2:1" });
    expect(a.mock?.calls.at(-1)?.args[0]).toMatchObject({ owner: "Claude", role: "Task Intake", status: "open", source: "vc" });
  });

  it("addresses the ops schema and merges duplicates", async () => {
    const calls = stubFetch(() => ({ status: 201, json: [{ id: "t1" }] }));
    const a = createTmosAdapter(realConfig({ TMOS_SUPABASE_URL: "https://proj.supabase.co" }));
    await a.createTask({ title: "t", external_key: "vc:s3:1" });
    expect(calls[0]!.url).toContain("/rest/v1/tasks?on_conflict=external_key");
    expect(calls[0]!.headers["content-profile"]).toBe("ops");
    expect(calls[0]!.headers["prefer"]).toContain("resolution=merge-duplicates");
  });
});

describe("llm adapter", () => {
  it("refuses a provider whose wire format it does not speak", () => {
    expect(() => createLlmAdapter(realConfig({ LLM_PROVIDER: "openai" })))
      .toThrow(AdapterError);
  });

  it("returns the fixture completion in mock mode", async () => {
    setMockCompletion(() => '[{"title":"x"}]');
    const a = createLlmAdapter(dryRun);
    expect((await a.complete({ system: "s", prompt: "p" })).text).toBe('[{"title":"x"}]');
    setMockCompletion(() => "[]");
  });

  it("sends temperature 0 by default so extraction is reproducible", async () => {
    const calls = stubFetch(() => ({ json: { content: [{ type: "text", text: "ok" }], model: "m" } }));
    const a = createLlmAdapter(realConfig());
    await a.complete({ system: "s", prompt: "p" });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ temperature: 0 });
  });
});

describe("the capture vendors are off the dial path", () => {
  it("all four are mock in dry_run and none blocks the dialer", async () => {
    const a = createAdapters(dryRun);
    for (const name of ["discord", "stt_batch", "tmos", "llm"] as const) {
      expect(a[name].mode).toBe("mock");
      expect((await a[name].healthcheck()).ok).toBe(true);
    }
  });
});
