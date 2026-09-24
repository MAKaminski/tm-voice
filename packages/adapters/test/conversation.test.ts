import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SOUND, CLOSING_REMINDER, type Facts, JOE_PROMPT, SPEECH_PLAN, buildSystemPrompt,
  mergeSystemPrompt, renderFacts, speechFields, speechPlanSchema, systemPromptOf,
} from "../src/index.js";

/** Two licences either side of a date, so one clock can prove the filter both ways. */
const FACTS: Facts = {
  licences: [
    { kind: "general_contractor", name: "Georgia general contractor — company", number: "RBCO007813", holder: "Transparent Maintenance", expires_on: "2030-06-30" },
    { kind: "lead_safe_firm", name: "Georgia certified lead-based paint renovation firm", number: "GA-EPD-RRP FIRM-398659", holder: "Transparent Maintenance Inc.", expires_on: "2026-12-14" },
    { kind: "registration", name: "Georgia Secretary of State control number", number: "22027249", holder: "Transparent Maintenance", expires_on: null },
  ],
  facts: [
    { key: "capacity", label: "Crews", value: "Maintenance: 2 technicians." },
    { key: "work_orders", label: "Work orders", value: "wo@transparentmaintenance.com" },
  ],
};
const NOW = new Date("2026-09-17T12:00:00Z");
const prompt = buildSystemPrompt({ disclosureLine: "Hi, this is an automated assistant.", scriptBody: "Ask about vendors.", facts: FACTS, now: NOW });

describe("the call-handling settings", () => {
  it("has ambient office noise off", () => {
    // Vapi's "office" loop is keyboard clatter and background chatter; on a real call it just
    // sounds like the caller is being phoned from a noisy room.
    expect(BACKGROUND_SOUND).toBe("off");
  });

  it("leaves the caller room to speak before taking a turn", () => {
    expect(SPEECH_PLAN.startWaitSeconds).toBeGreaterThan(0.5);
  });

  it("lets the caller interrupt in a couple of words", () => {
    expect(SPEECH_PLAN.interruptWords).toBeLessThanOrEqual(3);
    expect(SPEECH_PLAN.interruptBackoffSeconds).toBeGreaterThan(0);
  });

  /**
   * This test used to assert the opposite -- `toBeLessThanOrEqual(10)` -- on the mistaken belief
   * that the field prompts Joe to speak. It ends the call, so a low value is a hang-up timer and
   * the test was pinning the bug in place.
   */
  it("leaves room to look something up before ending the call", () => {
    expect(SPEECH_PLAN.silenceTimeoutSeconds).toBeGreaterThanOrEqual(15);
  });

  it("refuses a plan outside the ranges Vapi accepts", () => {
    expect(() => speechPlanSchema.parse({ ...SPEECH_PLAN, startWaitSeconds: 99 })).toThrow();
    expect(() => speechPlanSchema.parse({ ...SPEECH_PLAN, silenceTimeoutSeconds: 1 })).toThrow();
    // Vapi's documented floor is 10s; anything under it is rejected at their API, not clamped.
    expect(() => speechPlanSchema.parse({ ...SPEECH_PLAN, silenceTimeoutSeconds: 7 })).toThrow();
  });

  it("maps onto the Vapi field names", () => {
    expect(speechFields(SPEECH_PLAN)).toEqual({
      silenceTimeoutSeconds: 20,
      maxDurationSeconds: 480,
      startSpeakingPlan: { waitSeconds: 0.8 },
      stopSpeakingPlan: { numWords: 2, backoffSeconds: 1.5 },
    });
  });
});

describe("Joe's rules", () => {
  // The complaint this prompt answers: calls ending with no goodbye. These pin the fix itself.
  it("gates hanging up on a live person behind the questions-and-goodbye sequence", () => {
    expect(JOE_PROMPT).toContain("Before you are allowed to call the endCall tool with a live human on the line");
    expect(JOE_PROMPT).toContain("Before I let you go, are there any questions I can");
    expect(JOE_PROMPT).toContain('"I appreciate your time, take care."');
    expect(JOE_PROMPT).toContain("If all three have not happened, you may not end");
  });

  it("treats silence as a lookup, never as the end of the call", () => {
    expect(JOE_PROMPT).toContain("Silence is not permission to leave.");
    expect(JOE_PROMPT).toContain("Never treat silence as the end of the call.");
  });

  it("still ends at once on an opt-out, through the opt_out tool", () => {
    expect(JOE_PROMPT).toContain("Call the opt_out tool");
  });

  it("never lets Joe offer to help them", () => {
    expect(JOE_PROMPT).toContain("You are the one asking. Never ask them what they need.");
  });

  it("never claims to be human", () => {
    expect(JOE_PROMPT).toContain("Never claim to be human.");
    expect(JOE_PROMPT).toContain("in AI form");
  });

  it("reads contact details back slowly, from memory, with no tool in the way", () => {
    expect(JOE_PROMPT).toContain("read back email addresses letter by letter");
    expect(JOE_PROMPT).toContain("Never read an email address back as a single word");
    expect(JOE_PROMPT).not.toContain("capture_contact");
  });

  /**
   * docs/COMPLIANCE.md: 47 CFR 64.1200(b) requires an artificial voice to say so at the outset. The
   * fixed opening line is spoken during a voicemail greeting, before the beep, so it never reaches
   * the recording; the message has to carry the notice itself.
   */
  it("opens the voicemail and screener lines with the artificial-voice notice", () => {
    const vm = JOE_PROMPT.slice(JOE_PROMPT.indexOf("deliver this message once"));
    expect(vm.slice(0, 200)).toContain("automated assistant using an artificial");
    const screener = JOE_PROMPT.slice(JOE_PROMPT.indexOf("Automated screener"));
    expect(screener.slice(0, 250)).toContain("automated assistant using an artificial");
  });

  it("allows licence numbers only from the TM-OS list, and never insurance limits", () => {
    expect(JOE_PROMPT).toContain("Never state TM's insurance limits or EIN.");
    expect(JOE_PROMPT).toContain('listed under "What you may state about the company"');
  });
});

describe("the assembled prompt", () => {
  it("carries the disclosure line and forbids repeating it", () => {
    expect(prompt).toContain("Hi, this is an automated assistant.");
    expect(prompt).toContain("Never repeat it");
    expect(prompt).toContain("legal notice, not a greeting");
  });

  it("includes the campaign's own script body", () => {
    expect(prompt).toContain("Ask about vendors.");
  });

  /**
   * The rules that must hold go first and are restated last, because the start and the end of a
   * long prompt are what a model weights most. Everything assembled from data goes in between.
   */
  it("puts Section 0 first and the closing reminder last, with the data in between", () => {
    expect(prompt.startsWith(JOE_PROMPT)).toBe(true);
    expect(prompt.endsWith(CLOSING_REMINDER)).toBe(true);
    const section0 = prompt.indexOf("SECTION 0");
    for (const middle of ["Ask about vendors.", "## What you may state about the company", "## The opening line"]) {
      expect(prompt.indexOf(middle)).toBeGreaterThan(section0);
      expect(prompt.indexOf(middle)).toBeLessThan(prompt.indexOf(CLOSING_REMINDER));
    }
  });

  it("refuses to build without a disclosure line", () => {
    expect(() => buildSystemPrompt({ disclosureLine: "", scriptBody: "x", facts: FACTS, now: NOW })).toThrow();
  });
});

/**
 * The agent shipped knowing nothing about the company, so it answered "I don't know" to every
 * qualifying question a property manager asks before handing over a decision-maker.
 */
describe("the company facts", () => {
  it("states a licence that is current", () => {
    expect(renderFacts(FACTS, NOW)).toContain("RBCO007813");
  });

  it("states the facts that do not expire", () => {
    const out = renderFacts(FACTS, NOW);
    expect(out).toContain("Maintenance: 2 technicians.");
    expect(out).toContain("wo@transparentmaintenance.com");
  });

  it("keeps a registration number that has no expiry", () => {
    expect(renderFacts(FACTS, new Date("2030-01-01T00:00:00Z"))).toContain("22027249");
  });

  // The one that matters: a certificate is a claim about the present tense. Still telling a property
  // manager the company is a certified renovation firm the day after it lapsed is a false statement.
  it("drops a licence the day after it expires", () => {
    const after = renderFacts(FACTS, new Date("2026-12-15T09:00:00Z"));
    expect(after).not.toContain("GA-EPD-RRP FIRM-398659");
    expect(after).toContain("RBCO007813");   // the others are untouched
  });

  it("still states it on the last day it is valid", () => {
    expect(renderFacts(FACTS, new Date("2026-12-14T23:00:00Z"))).toContain("GA-EPD-RRP FIRM-398659");
  });

  it("never claims the company is insured", () => {
    // Licences and insurance are different things, and the auto liability COI is expired.
    const out = renderFacts(FACTS, NOW);
    expect(out).toContain("Do not say the company is insured");
  });

  it("tells the agent to say it does not know rather than invent a fact", () => {
    expect(renderFacts(FACTS, NOW)).toContain("say you do not know");
  });

  it("carries the facts into the assembled prompt", () => {
    expect(prompt).toContain("## What you may state about the company");
    expect(prompt).toContain("RBCO007813");
  });

  it("never leaks a referral or a personal detail", () => {
    // Michael's instruction: no referrals. And nothing personal from the renovator certificate.
    for (const banned of ["Silberman", "Square Properties", "All County Legacy", "Emerald", "11/16/1995", "Sherwin"]) {
      expect(prompt).not.toContain(banned);
    }
  });
});

describe("merging the prompt into a live assistant", () => {
  const live = {
    id: "asst_1",
    model: {
      provider: "openai", model: "gpt-4o", temperature: 0.4, toolIds: ["tool_book", "tool_optout"],
      messages: [{ role: "system", content: "old prompt" }, { role: "assistant", content: "keep me" }],
    },
  };

  it("replaces only the system message and keeps the tool wiring", () => {
    const merged = mergeSystemPrompt(live, "new prompt");
    // The whole point: a rebuilt model object would silently drop these.
    expect(merged["toolIds"]).toEqual(["tool_book", "tool_optout"]);
    expect(merged["provider"]).toBe("openai");
    expect(merged["temperature"]).toBe(0.4);
    const messages = merged["messages"] as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "system", content: "new prompt" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "keep me" });
  });

  it("adds a system message when the assistant has none", () => {
    const merged = mergeSystemPrompt({ id: "a", model: { provider: "openai" } }, "new prompt");
    expect((merged["messages"] as { content: string }[])[0]!.content).toBe("new prompt");
    expect(merged["provider"]).toBe("openai");
  });

  it("does not mutate the live object it was handed", () => {
    mergeSystemPrompt(live, "new prompt");
    expect(live.model.messages[0]!.content).toBe("old prompt");
  });

  it("reads a prompt back out of a live assistant", () => {
    expect(systemPromptOf(live)).toBe("old prompt");
    expect(systemPromptOf({ id: "a" })).toBeUndefined();
  });
});
