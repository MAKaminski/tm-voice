import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, useMock, validate } from "../base.js";

/**
 * Batch speech-to-text for a recorded file.
 *
 * The vendor is an OPEN DECISION and this adapter is deliberately mock-only. tm-voice's existing
 * STT is Soniox streaming, bundled inside Vapi, which cannot transcribe a file — so nothing here
 * can be reused and something new has to be chosen. It is not chosen yet, on purpose: adopting
 * Deepgram here would contaminate the Phase 6.5 trigger audit, which is meant to measure whether
 * the dial path ever needed a second STT vendor at all.
 *
 * The interface is the whole point. Every real provider (Soniox batch, Deepgram, Groq/Whisper)
 * takes bytes plus a media type and returns timed segments, so `transcribeFile` is the shape a
 * real client drops into without the M2 pipeline changing. When a provider is picked, add a real
 * branch below; do not add a second method and do not widen this one to stream.
 *
 * REQUEST_BYTE_LIMIT is assumed, not measured — 25 MB is the common cap and M2 chunks to it.
 */
export const REQUEST_BYTE_LIMIT = 25 * 1024 * 1024;

export const segment = z.object({
  start_sec: z.number().nonnegative(),
  end_sec: z.number().nonnegative(),
  text: z.string(),
});
export type Segment = z.infer<typeof segment>;

export const transcribeFileInput = z.object({
  /** Opaque handle for logs and mock determinism — an R2 key in practice. */
  key: z.string().min(1),
  audio: z.instanceof(Uint8Array),
  content_type: z.string().min(1),
  /** Seconds already elapsed in the meeting when this chunk starts; segments come back absolute. */
  offset_sec: z.number().nonnegative().default(0),
});
export type TranscribeFileInput = z.input<typeof transcribeFileInput>;

export interface SttBatchAdapter extends Adapter {
  transcribeFile(input: TranscribeFileInput): Promise<{ segments: Segment[] }>;
}

/**
 * Deterministic fixture transcription. Keyed on `key` so a replayed job produces byte-identical
 * segments — M2's idempotency test depends on that, and a random mock would hide a real bug.
 */
export function mockSegments(key: string, offsetSec: number): Segment[] {
  const fixture = MOCK_FIXTURES[key];
  const lines = fixture ?? [`mock transcript for ${key}`];
  return lines.map((text, i) => ({ start_sec: offsetSec + i * 5, end_sec: offsetSec + i * 5 + 4, text }));
}

/** Seeded utterances used by the M2/M3 tests. Extend rather than randomise. */
export const MOCK_FIXTURES: Record<string, string[]> = {};

export function createSttBatchAdapter(cfg: Config): SttBatchAdapter & { mock?: MockRecorder } {
  // There is no real branch: this adapter is mock in every mode, including live. Keys being set is
  // therefore not a promise that anything is transcribed for real, and /health says so rather than
  // reporting a healthy vendor that does not exist.
  const configured = !useMock(cfg, "STT_BATCH_PROVIDER", "STT_BATCH_API_KEY");
  const mock = new MockRecorder();
  return {
    name: "stt_batch", mode: "mock", mock,
    async healthcheck() {
      const detail = configured
        ? `keys set for "${cfg.STT_BATCH_PROVIDER}" but no client is implemented — still mock`
        : "no provider chosen — mock only";
      return { vendor: "stt_batch", ok: true, mode: "mock" as const, detail };
    },
    async transcribeFile(input) {
      const v = validate("stt_batch", transcribeFileInput, input);
      if (v.audio.byteLength > REQUEST_BYTE_LIMIT) {
        // The caller is responsible for chunking; failing loudly here stops a silent truncation.
        throw new AdapterError({
          vendor: "stt_batch", code: "payload_too_large", retryable: false,
          raw: { key: v.key, bytes: v.audio.byteLength, limit: REQUEST_BYTE_LIMIT },
        });
      }
      mock.record("transcribeFile", { key: v.key, bytes: v.audio.byteLength, content_type: v.content_type, offset_sec: v.offset_sec });
      return { segments: mockSegments(v.key, v.offset_sec) };
    },
  };
}
