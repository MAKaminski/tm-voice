import { createHmac, timingSafeEqual } from "node:crypto";
import { AdapterError, type Config } from "@tm/shared";
import { z } from "zod";
import { type Adapter, MockRecorder, assertDialAllowed, e164, request, useMock, validate } from "../base.js";
import { BACKGROUND_SOUND, RECORDING_ENABLED, SPEECH_PLAN, type SpeechPlan, speechPlanSchema } from "./conversation.js";
import { vapiVoiceSchema } from "./voice.js";

export * from "./conversation.js";
export * from "./voice.js";

const API = "https://api.vapi.ai";

export const outboundCallInput = z.object({
  to: e164,
  from: e164,
  assistant_id: z.string(),
  metadata: z.object({ call_task_id: z.string().uuid(), contact_id: z.string().uuid() }),
});
export type OutboundCallInput = z.infer<typeof outboundCallInput>;

/**
 * The part of the assistant this repo owns.
 *
 * This used to be two fields — the opening line and the voice — on the reasoning that model,
 * tools and transcriber were dashboard territory. Joe's feedback from a real call retired that
 * split: every complaint except the legal notice traced to the system prompt or to a call-handling
 * setting, i.e. to exactly the surface nobody could review. An agent that hangs up on a prospect
 * mid-sentence is not a dashboard preference.
 *
 * So the owned surface now also covers the system prompt and the behaviour settings. It still
 * stops short of the model choice, the transcriber and the tool wiring: `updateAssistant` reads
 * the live `model` object and replaces only its `messages`, so which LLM the assistant runs and
 * which tools it can call remain dashboard decisions and a sync cannot clobber them.
 */
export const assistantDesiredState = z.object({
  firstMessage: z.string().min(1),
  voice: vapiVoiceSchema,
  /** Becomes model.messages[0].content; the rest of the model object is left as it is found. */
  systemPrompt: z.string().min(1),
  backgroundSound: z.literal("off"),
  speech: speechPlanSchema,
  /** Maps to Vapi's artifactPlan.recordingEnabled. The disclosure line promises this is true. */
  recordingEnabled: z.literal(true),
});
export type AssistantDesiredState = z.infer<typeof assistantDesiredState>;

/** The subset of a live Vapi assistant the sync reads. `model` is carried through, not replaced. */
export interface LiveAssistant {
  id: string;
  firstMessage?: string;
  voice?: Record<string, unknown>;
  backgroundSound?: string;
  artifactPlan?: Record<string, unknown> & { recordingEnabled?: boolean };
  model?: Record<string, unknown> & { messages?: { role: string; content?: string }[] };
  silenceTimeoutSeconds?: number;
  maxDurationSeconds?: number;
  startSpeakingPlan?: Record<string, unknown>;
  stopSpeakingPlan?: Record<string, unknown>;
}

/** The system prompt as Vapi stores it: the first `system` message on the model object. */
export const systemPromptOf = (live: LiveAssistant): string | undefined =>
  live.model?.messages?.find((m) => m.role === "system")?.content;

/**
 * Merge the desired prompt into the live model object, leaving provider, model name, temperature
 * and tool wiring exactly as the dashboard has them. Vapi replaces a nested object wholesale on
 * PATCH, so sending a freshly built `model` would silently drop the assistant's tools.
 */
export function mergeSystemPrompt(live: LiveAssistant, systemPrompt: string): Record<string, unknown> {
  const model = { ...(live.model ?? {}) };
  const messages = [...(live.model?.messages ?? [])];
  const at = messages.findIndex((m) => m.role === "system");
  if (at >= 0) messages[at] = { ...messages[at], role: "system", content: systemPrompt };
  else messages.unshift({ role: "system", content: systemPrompt });
  model["messages"] = messages;
  return model;
}

/**
 * Merge recording into the live artifact plan. Same reasoning as `mergeSystemPrompt`: the plan also
 * carries the transcript and structured-data configuration that `postcall.process` depends on, and
 * a rebuilt object would drop it.
 */
export function mergeArtifactPlan(live: LiveAssistant, recordingEnabled: boolean): Record<string, unknown> {
  return { ...(live.artifactPlan ?? {}), recordingEnabled };
}

/** The Vapi fields a speech plan maps onto. Kept next to the plan so the mapping is reviewable. */
export function speechFields(plan: SpeechPlan): Record<string, unknown> {
  return {
    silenceTimeoutSeconds: plan.silenceTimeoutSeconds,
    maxDurationSeconds: plan.maxDurationSeconds,
    startSpeakingPlan: { waitSeconds: plan.startWaitSeconds },
    stopSpeakingPlan: {
      numWords: plan.interruptWords,
      backoffSeconds: plan.interruptBackoffSeconds,
    },
  };
}

export interface VapiAdapter extends Adapter {
  createOutboundCall(input: OutboundCallInput): Promise<{ id: string; synthetic: boolean }>;
  getCall(id: string): Promise<{ id: string; status: string; recording_url?: string; transcript?: unknown }>;
  /** Reads back the fields `updateAssistant` owns, so a sync can tell drift from a no-op. */
  getAssistant(id: string): Promise<LiveAssistant>;
  /**
   * PATCHes the owned surface. Partial: unnamed fields are untouched. The caller passes the live
   * assistant so the model object can be merged rather than replaced (see `mergeSystemPrompt`).
   *
   * On rule 3 ("no code path reaches Vapi without a passing gate"): this one carries no contact and
   * places no call, so there is no CALL_TASK to gate. The gate answers "may we dial this person";
   * this answers "how should the agent sound when we do". `assertDialAllowed` stays on the dial
   * methods only — putting it here would make configuring the voice require a dialable prospect.
   */
  updateAssistant(id: string, desired: AssistantDesiredState, live?: LiveAssistant): Promise<{ id: string; synthetic: boolean }>;
  /**
   * Fetch a recording Vapi has stored. The URL comes from the end-of-call report or `getCall`, and
   * is short-lived — which is why the caller is a retryable job rather than an inline step.
   *
   * Lives in the adapter rather than the processor because it is a vendor fetch like any other
   * (rule 1), and because the timeout and error classification then match every other Vapi call.
   */
  downloadRecording(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * Verifies a Vapi server webhook. Vapi sends the configured server secret as `x-vapi-secret`;
   * an HMAC-SHA256 in `x-vapi-signature` is also accepted for forward compatibility.
   */
  verifyWebhook(headers: { secret?: string; signature?: string }, rawBody: string): boolean;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function webhookOk(secret: string, headers: { secret?: string; signature?: string }, rawBody: string): boolean {
  if (headers.secret && safeEq(headers.secret, secret)) return true;
  if (headers.signature) return safeEq(createHmac("sha256", secret).update(rawBody).digest("hex"), headers.signature);
  return false;
}

export function createVapiAdapter(cfg: Config): VapiAdapter & { mock?: MockRecorder } {
  if (useMock(cfg, "VAPI_PRIVATE_KEY", "VAPI_WEBHOOK_SECRET", "VAPI_ASSISTANT_ID")) {
    const mock = new MockRecorder();
    const secret = cfg.VAPI_WEBHOOK_SECRET ?? "mock-vapi-secret";
    return {
      name: "vapi", mode: "mock", mock,
      async healthcheck() { return { vendor: "vapi", ok: true, mode: "mock" as const }; },
      async createOutboundCall(input) {
        const v = validate("vapi", outboundCallInput, input);
        mock.record("createOutboundCall", v);
        // dry_run: never network. Return a synthetic call the worker records as disposition=dry_run.
        return { id: `dryrun_${v.metadata.call_task_id}`, synthetic: true };
      },
      async getCall(id) { mock.record("getCall", id); return { id, status: "ended" }; },
      async downloadRecording(url) {
        mock.record("downloadRecording", url);
        return { bytes: new TextEncoder().encode(`mock-audio:${url}`), contentType: "audio/wav" };
      },
      async getAssistant(id) { mock.record("getAssistant", id); return { id }; },
      async updateAssistant(id, desired, live) {
        const v = validate("vapi", assistantDesiredState, desired);
        mock.record("updateAssistant", id, v, {
          model: mergeSystemPrompt(live ?? { id }, v.systemPrompt),
          artifactPlan: mergeArtifactPlan(live ?? { id }, v.recordingEnabled),
        });
        // dry_run never mutates a live assistant; the recorder is what the test and the log read.
        return { id, synthetic: true };
      },
      verifyWebhook(h, body) { return webhookOk(secret, h, body); },
    };
  }
  const auth = { authorization: `Bearer ${cfg.VAPI_PRIVATE_KEY!}` };
  /** phoneNumberId is cached per process: the DID set changes rarely and every dial would otherwise pay a lookup. */
  const phoneNumberIds = new Map<string, string>();

  async function resolvePhoneNumberId(fromE164: string): Promise<string> {
    const hit = phoneNumberIds.get(fromE164);
    if (hit) return hit;
    const numbers = await request<{ id?: string; number?: string }[]>({ vendor: "vapi", url: `${API}/phone-number`, query: { limit: 1000 }, headers: auth });
    for (const n of numbers ?? []) if (n.number && n.id) phoneNumberIds.set(n.number, n.id);
    const id = phoneNumberIds.get(fromE164);
    if (!id) {
      throw new AdapterError({
        vendor: "vapi", code: "unknown_from_number", retryable: false,
        message: `${fromE164} is not imported into Vapi; import the Telnyx DID as a BYO phone number first`,
      });
    }
    return id;
  }

  return {
    name: "vapi", mode: "real",
    async healthcheck() {
      const r = await fetch(`https://api.vapi.ai/assistant/${cfg.VAPI_ASSISTANT_ID!}`, { headers: { Authorization: `Bearer ${cfg.VAPI_PRIVATE_KEY!}` } });
      return { vendor: "vapi", ok: r.ok, mode: "real", detail: r.ok ? undefined : `HTTP ${r.status}` };
    },
    async createOutboundCall(input) {
      const v = validate("vapi", outboundCallInput, input);
      assertDialAllowed(cfg, "vapi", v.to);
      const phoneNumberId = await resolvePhoneNumberId(v.from);
      const res = await request<{ id?: string }>({
        vendor: "vapi", method: "POST", url: `${API}/call`, headers: auth,
        body: {
          assistantId: v.assistant_id,
          phoneNumberId,
          customer: { number: v.to },
          // Vapi's call object has no metadata field, so the correlation id rides in `name`
          // (max 40 chars, and a UUID is 36). The post-call webhook reads it back to find the call_task.
          name: v.metadata.call_task_id,
        },
      });
      if (!res.id) throw new AdapterError({ vendor: "vapi", code: "missing_call_id", retryable: false, raw: res });
      return { id: res.id, synthetic: false };
    },
    async getCall(id) {
      const res = await request<{
        id?: string; status?: string;
        artifact?: { recordingUrl?: string; stereoRecordingUrl?: string; transcript?: string };
      }>({ vendor: "vapi", url: `${API}/call/${encodeURIComponent(id)}`, headers: auth });
      return {
        id: res.id ?? id,
        status: res.status ?? "unknown",
        recording_url: res.artifact?.recordingUrl ?? res.artifact?.stereoRecordingUrl,
        transcript: res.artifact?.transcript,
      };
    },
    async downloadRecording(url) {
      // Not through `request()`: that helper decodes JSON, and this is audio. The error shape is
      // mapped by hand to match what every other Vapi method throws.
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        throw new AdapterError({ vendor: "vapi", code: "network_error", retryable: true, raw: (e as Error).message });
      }
      if (!res.ok) {
        // A recording URL expires, and an expired one is not worth retrying forever.
        throw new AdapterError({ vendor: "vapi", code: `http_${res.status}`, retryable: res.status === 429 || res.status >= 500, raw: url });
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) throw new AdapterError({ vendor: "vapi", code: "empty_recording", retryable: false, raw: url });
      return { bytes, contentType: res.headers.get("content-type") ?? "audio/wav" };
    },
    async getAssistant(id) {
      const res = await request<LiveAssistant & { id?: string }>({
        vendor: "vapi", url: `${API}/assistant/${encodeURIComponent(id)}`, headers: auth,
      });
      return { ...res, id: res.id ?? id };
    },
    async updateAssistant(id, desired, live) {
      const v = validate("vapi", assistantDesiredState, desired);
      // Read the live assistant when the caller did not supply it: the model object has to be
      // merged, and PATCHing a rebuilt one would drop the assistant's tool wiring.
      const current = live ?? (await this.getAssistant(id));
      const res = await request<{ id?: string }>({
        vendor: "vapi", method: "PATCH", url: `${API}/assistant/${encodeURIComponent(id)}`, headers: auth,
        body: {
          firstMessage: v.firstMessage,
          voice: v.voice,
          backgroundSound: v.backgroundSound,
          model: mergeSystemPrompt(current, v.systemPrompt),
          artifactPlan: mergeArtifactPlan(current, v.recordingEnabled),
          ...speechFields(v.speech),
        },
      });
      return { id: res.id ?? id, synthetic: false };
    },
    verifyWebhook(h, body) { return webhookOk(cfg.VAPI_WEBHOOK_SECRET!, h, body); },
  };
}
