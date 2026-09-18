/**
 * Joe's voice, in version control.
 *
 * Until this file existed the tuning lived only in the Vapi dashboard on assistant
 * `VAPI_ASSISTANT_ID`: anyone could change how the agent sounds to a prospect and no diff,
 * review or CI run would show it. The profile below is the desired state. `vapi.syncAssistant`
 * reconciles the live assistant against it, so the dashboard is a view and this file is the
 * source of truth.
 *
 * Ranges and semantics come from ElevenLabs' voice-settings docs and Vapi's `11labs` voice
 * schema; `pnpm voice:check` enforces them before anything reaches a live call.
 */
import { z } from "zod";

/**
 * ElevenLabs models Vapi accepts for the `11labs` provider. `style` and `useSpeakerBoost` are
 * only honoured on V2 and newer, which is why the v1 entries stay in the enum: the schema below
 * refuses a profile that sets style on a model that would silently ignore it.
 */
export const ELEVENLABS_MODELS = [
  "eleven_monolingual_v1",
  "eleven_multilingual_v1",
  "eleven_multilingual_v2",
  "eleven_turbo_v2",
  "eleven_turbo_v2_5",
  "eleven_flash_v2",
  "eleven_flash_v2_5",
] as const;
export type ElevenLabsModel = (typeof ELEVENLABS_MODELS)[number];

const V2_OR_NEWER = /_v2(_\d+)?$/;
export const supportsStyle = (model: ElevenLabsModel): boolean => V2_OR_NEWER.test(model);

/** ElevenLabs clamps speed to this range; anything outside it is rejected at the API, not rounded. */
export const SPEED_MIN = 0.7, SPEED_MAX = 1.2;

const voiceProfileShape = {
    model: z.enum(ELEVENLABS_MODELS),
    /**
     * Lower is more expressive. High stability flattens prosody into a monotone, which on a cold
     * outbound call reads as bored or downbeat rather than calm.
     */
    stability: z.number().min(0).max(1),
    /** How closely the render sticks to the source recording. Pushing this up re-flattens delivery. */
    similarityBoost: z.number().min(0).max(1),
    /** Style exaggeration. 0 (the ElevenLabs default) is the flat read; raising it costs some latency. */
    style: z.number().min(0).max(1),
    useSpeakerBoost: z.boolean(),
    speed: z.number().min(SPEED_MIN).max(SPEED_MAX),
} as const;

/** Rejects a profile whose style would be silently dropped by the model it names. */
function refineStyle(v: { model: ElevenLabsModel; style: number }, ctx: z.RefinementCtx): void {
  if (v.style > 0 && !supportsStyle(v.model)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["style"],
      message: `style ${v.style} is ignored by ${v.model}; style needs a V2-or-newer model`,
    });
  }
}

export const voiceProfileSchema = z.object(voiceProfileShape).superRefine(refineStyle);
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

/** The same tuning plus the two fields Vapi needs to address a voice. This is what gets PATCHed. */
export const vapiVoiceSchema = z
  .object({ provider: z.literal("11labs"), voiceId: z.string().min(1), ...voiceProfileShape })
  .superRefine(refineStyle);

/**
 * The tuning itself. Each value is a decision, so change them one at a time and listen:
 *
 * - `stability` 0.30 — was the flat read. This is the single biggest lever on perceived mood.
 * - `style` 0.40 — off by default at ElevenLabs. This is what adds warmth and lift.
 * - `speed` 1.07 — a slow delivery reads as downbeat; this is a nudge, not a rush.
 * - `similarityBoost` 0.75 — ElevenLabs' default, deliberately unchanged.
 * - `useSpeakerBoost` — keeps Joe's timbre recognisable while the three above loosen up.
 *
 * Flash is chosen for latency (docs/RUNBOOK.md prices the call on it). It is V2-class, so it
 * honours `style`. If calls start feeling laggy, take style down before touching the model.
 *
 * `model` is not a free knob when `ELEVENLABS_VOICE_ID` names a Professional Voice Clone. A PVC is
 * fine-tuned per model, so this value selects a fine-tune that may not exist yet: ElevenLabs then
 * refuses to render and Vapi ends the call with
 * `pipeline-error-eleven-labs-voice-not-fine-tuned-and-cannot-be-used`. Nothing here can see that —
 * the profile is valid, the PATCH succeeds, CI passes, and the failure appears only as an
 * `ended_reason` on a live call. Before changing `model`, check the voice has that model's
 * fine-tune in the ElevenLabs dashboard (docs/RUNBOOK.md § 7b).
 *
 * Deliberately a plain literal rather than a `schema.parse(...)` at module load: parsing here would
 * turn a bad edit into an import-time stack trace in every CI job at once. `pnpm voice:check` and
 * the adapter's own `validate()` on each PATCH are the gates, and both report which knob is wrong.
 */
export const VOICE_PROFILE: VoiceProfile = {
  model: "eleven_flash_v2_5",
  stability: 0.3,
  similarityBoost: 0.75,
  style: 0.4,
  useSpeakerBoost: true,
  speed: 1.07,
};

export type VapiVoiceBlock = z.infer<typeof vapiVoiceSchema>;

/** The `voice` block Vapi stores on the assistant. `voiceId` is deployment config, so it comes from env. */
export function vapiVoiceBlock(voiceId: string, profile: VoiceProfile = VOICE_PROFILE): VapiVoiceBlock {
  return vapiVoiceSchema.parse({ provider: "11labs", voiceId, ...profile });
}
