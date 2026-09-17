import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, request, useMock, validate } from "../base.js";

/**
 * The first LLM client in this repo. LLM_* keys already existed in config and infra/env.example,
 * but nothing read them: the dial path's model lives inside Vapi's own Provider Keys, so tm-voice
 * never had to call a model itself. Mining a meeting transcript for commitments is the first job
 * that does.
 *
 * Deliberately narrow: one `complete()` that takes a system prompt and a user message and returns
 * text. No streaming, no tool use, no conversation state — a batch extraction step needs none of
 * it, and every one of them would be a second pattern to maintain.
 */
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export const completeInput = z.object({
  system: z.string().min(1),
  prompt: z.string().min(1),
  max_tokens: z.number().int().positive().max(64_000).default(4096),
  /** 0 for extraction: the same transcript must yield the same tasks on a replay. */
  temperature: z.number().min(0).max(1).default(0),
});
export type CompleteInput = z.input<typeof completeInput>;

export interface LlmAdapter extends Adapter {
  complete(input: CompleteInput): Promise<{ text: string; model: string }>;
}

/** Overridable in tests so a fixture extraction can be asserted without a network call. */
export let mockCompletion: (input: z.infer<typeof completeInput>) => string = () => "[]";
export function setMockCompletion(fn: (input: z.infer<typeof completeInput>) => string): void {
  mockCompletion = fn;
}

export function createLlmAdapter(cfg: Config): LlmAdapter & { mock?: MockRecorder } {
  const model = cfg.LLM_MODEL ?? DEFAULT_MODEL;

  if (useMock(cfg, "LLM_API_KEY")) {
    const mock = new MockRecorder();
    return {
      name: "llm", mode: "mock", mock,
      async healthcheck() { return { vendor: "llm", ok: true, mode: "mock" as const }; },
      async complete(input) {
        const v = validate("llm", completeInput, input);
        mock.record("complete", v);
        return { text: mockCompletion(v), model: `mock:${model}` };
      },
    };
  }

  if (cfg.LLM_PROVIDER && cfg.LLM_PROVIDER !== "anthropic") {
    // infra/env.example allows "openai" as a value, but only the Anthropic wire format is written.
    // Failing at construction beats discovering it on the first meeting of the day.
    throw new AdapterError({ vendor: "llm", code: "unsupported_provider", retryable: false, raw: { provider: cfg.LLM_PROVIDER } });
  }

  const headers = () => ({
    "x-api-key": cfg.LLM_API_KEY!,
    "anthropic-version": ANTHROPIC_VERSION,
  });

  return {
    name: "llm", mode: "real",
    async healthcheck() {
      // A 1-token completion is the cheapest call that proves the key authenticates AND the model
      // id is real; /models would prove only the first.
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      if (r.ok) return { vendor: "llm", ok: true, mode: "real", detail: model };
      return { vendor: "llm", ok: false, mode: "real", detail: `HTTP ${r.status}` };
    },
    async complete(input) {
      const v = validate("llm", completeInput, input);
      const res = await request<{ content?: { type: string; text?: string }[]; model?: string }>({
        vendor: "llm", method: "POST", url: "https://api.anthropic.com/v1/messages",
        headers: headers(),
        body: {
          model, max_tokens: v.max_tokens, temperature: v.temperature, system: v.system,
          messages: [{ role: "user", content: v.prompt }],
        },
        // Extraction runs once per meeting and is not latency-sensitive; a long transcript can take
        // well over the 15s default before the first byte.
        timeoutMs: 120_000,
      });
      const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (!text) throw new AdapterError({ vendor: "llm", code: "empty_completion", retryable: false, raw: res });
      return { text, model: res.model ?? model };
    },
  };
}
