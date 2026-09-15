import { describe, expect, it } from "vitest";
import { ELEVENLABS_MODELS, SPEED_MAX, SPEED_MIN, VOICE_PROFILE, supportsStyle, vapiVoiceBlock, vapiVoiceSchema, voiceProfileSchema } from "../src/index.js";

const valid = { ...VOICE_PROFILE };

describe("voice profile", () => {
  it("is a shape ElevenLabs accepts", () => {
    expect(voiceProfileSchema.safeParse(VOICE_PROFILE).success).toBe(true);
  });

  it("is tuned for an upbeat read, not the flat default", () => {
    // These are the three levers that decide perceived mood. A future edit that flattens the voice
    // again should have to change this test and say why.
    expect(VOICE_PROFILE.stability).toBeLessThan(0.5);
    expect(VOICE_PROFILE.style).toBeGreaterThan(0);
    expect(VOICE_PROFILE.speed).toBeGreaterThan(1);
  });

  it("names a model that actually honours style", () => {
    expect(supportsStyle(VOICE_PROFILE.model)).toBe(true);
  });

  it("rejects style on a model that would silently ignore it", () => {
    const r = voiceProfileSchema.safeParse({ ...valid, model: "eleven_monolingual_v1" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toMatch(/style needs a V2-or-newer model/);
  });

  it("allows style 0 on a v1 model, since nothing is being silently dropped", () => {
    expect(voiceProfileSchema.safeParse({ ...valid, model: "eleven_monolingual_v1", style: 0 }).success).toBe(true);
  });

  it("holds speed inside the range the vendor accepts", () => {
    expect(voiceProfileSchema.safeParse({ ...valid, speed: SPEED_MAX + 0.01 }).success).toBe(false);
    expect(voiceProfileSchema.safeParse({ ...valid, speed: SPEED_MIN - 0.01 }).success).toBe(false);
    expect(voiceProfileSchema.safeParse({ ...valid, speed: SPEED_MAX }).success).toBe(true);
  });

  it("holds the 0–1 settings inside 0–1", () => {
    for (const k of ["stability", "similarityBoost", "style"] as const) {
      expect(voiceProfileSchema.safeParse({ ...valid, [k]: 1.5 }).success).toBe(false);
      expect(voiceProfileSchema.safeParse({ ...valid, [k]: -0.1 }).success).toBe(false);
    }
  });

  it("classifies every model in the enum as v1 or v2+", () => {
    const v2 = ELEVENLABS_MODELS.filter(supportsStyle);
    expect(v2).toEqual(["eleven_multilingual_v2", "eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_flash_v2", "eleven_flash_v2_5"]);
  });
});

describe("vapiVoiceBlock", () => {
  it("adds the two fields Vapi needs to address the voice", () => {
    expect(vapiVoiceBlock("voice_joe")).toEqual({ provider: "11labs", voiceId: "voice_joe", ...VOICE_PROFILE });
  });

  it("refuses an empty voiceId rather than PATCHing a broken assistant", () => {
    expect(() => vapiVoiceBlock("")).toThrow();
  });

  it("carries the style rule through to the wire shape", () => {
    expect(vapiVoiceSchema.safeParse({ provider: "11labs", voiceId: "v", ...valid, model: "eleven_multilingual_v1" }).success).toBe(false);
  });
});
