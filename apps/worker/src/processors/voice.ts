import { eq } from "drizzle-orm";
import {
  type AssistantDesiredState, BACKGROUND_SOUND, type LiveAssistant, RECORDING_ENABLED, SPEECH_PLAN, VOICE_PROFILE,
  buildSystemPrompt, systemPromptOf, vapiVoiceBlock,
} from "@tm/adapters";
import { scriptVersion } from "@tm/db";
import { logger } from "@tm/shared";
import type { Ctx, Processor } from "../context.js";

/** Voice fields the sync owns. Anything not listed here or below is dashboard territory. */
const OWNED_VOICE = ["provider", "voiceId", "model", "stability", "similarityBoost", "style", "useSpeakerBoost", "speed"] as const;

/**
 * Builds what the Vapi assistant should look like: the active SCRIPT_VERSION's disclosure line
 * verbatim (CLAUDE.md rule 10) and the checked-in voice profile.
 *
 * Exactly one script_version is expected to be active. More than one is a seeding bug, and
 * picking an arbitrary row would mean dialling with an unreviewed opening line, so it throws.
 */
export async function desiredAssistant(ctx: Ctx): Promise<AssistantDesiredState> {
  const voiceId = ctx.cfg.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error("vapi.syncAssistant requires ELEVENLABS_VOICE_ID (which voice Joe is)");

  const active = await ctx.db.select({ id: scriptVersion.id, line: scriptVersion.disclosureLine, body: scriptVersion.body })
    .from(scriptVersion).where(eq(scriptVersion.active, true));
  if (active.length !== 1) {
    throw new Error(`expected exactly 1 active script_version, found ${active.length}; refusing to guess the opening line`);
  }
  const row = active[0]!;
  return {
    firstMessage: row.line,
    voice: vapiVoiceBlock(voiceId, VOICE_PROFILE),
    systemPrompt: buildSystemPrompt({ disclosureLine: row.line, scriptBody: row.body }),
    backgroundSound: BACKGROUND_SOUND,
    speech: SPEECH_PLAN,
    recordingEnabled: RECORDING_ENABLED,
  };
}

/** Field-by-field diff of the owned surface, so the log names what drifted rather than "changed". */
export function assistantDrift(desired: AssistantDesiredState, live: LiveAssistant): string[] {
  const drift: string[] = [];
  if (live.firstMessage !== desired.firstMessage) drift.push("firstMessage");
  for (const k of OWNED_VOICE) {
    if (live.voice?.[k] !== (desired.voice as Record<string, unknown>)[k]) drift.push(`voice.${k}`);
  }
  // The prompt is the field most likely to be edited in the dashboard mid-incident, so it is
  // compared in full rather than by length or hash — a one-line edit still shows up as drift.
  if (systemPromptOf(live) !== desired.systemPrompt) drift.push("systemPrompt");
  if (live.backgroundSound !== desired.backgroundSound) drift.push("backgroundSound");
  // Recording off is the one drift with a compliance consequence: the disclosure line says the
  // call is being recorded, so an assistant with it switched off makes the agent say something untrue.
  if (live.artifactPlan?.recordingEnabled !== desired.recordingEnabled) drift.push("artifactPlan.recordingEnabled");
  if (live.silenceTimeoutSeconds !== desired.speech.silenceTimeoutSeconds) drift.push("silenceTimeoutSeconds");
  if (live.maxDurationSeconds !== desired.speech.maxDurationSeconds) drift.push("maxDurationSeconds");
  if (live.startSpeakingPlan?.["waitSeconds"] !== desired.speech.startWaitSeconds) drift.push("startSpeakingPlan.waitSeconds");
  if (live.stopSpeakingPlan?.["numWords"] !== desired.speech.interruptWords) drift.push("stopSpeakingPlan.numWords");
  if (live.stopSpeakingPlan?.["backoffSeconds"] !== desired.speech.interruptBackoffSeconds) drift.push("stopSpeakingPlan.backoffSeconds");
  return drift;
}

/**
 * Reconciles the live Vapi assistant against this repo. Runs on a schedule, so a change made in
 * the dashboard is reverted to the reviewed profile within a day and the revert is logged.
 *
 * Idempotent by comparison rather than by job id: the scheduler reuses one key forever, so the
 * read-diff-write here is what stops a PATCH on every tick.
 */
export const vapiSyncAssistant: Processor = async (ctx) => {
  const assistantId = ctx.cfg.VAPI_ASSISTANT_ID;
  if (!assistantId) {
    logger.warn("vapi.syncAssistant skipped: VAPI_ASSISTANT_ID is unset");
    return { skipped: "no_assistant_id" };
  }
  const desired = await desiredAssistant(ctx);

  // In dry_run the adapter is mocked and getAssistant returns a bare row, so every field reads as
  // drift and the mock records the PATCH it would have sent. That is the point of a dry run.
  const live = await ctx.adapters.vapi.getAssistant(assistantId);
  const drift = assistantDrift(desired, live);
  if (!drift.length) return { assistant_id: assistantId, in_sync: true };

  // `live` is handed over so the PATCH merges the model object and keeps the tool wiring.
  const res = await ctx.adapters.vapi.updateAssistant(assistantId, desired, live);
  logger.info({ assistant_id: assistantId, drift, synthetic: res.synthetic }, "vapi assistant reconciled to the checked-in profile");
  return { assistant_id: assistantId, in_sync: false, drift, synthetic: res.synthetic };
};
