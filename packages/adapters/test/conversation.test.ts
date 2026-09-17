import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SOUND, CONVERSATION_RULES, OBJECTIVE, SPEECH_PLAN, buildSystemPrompt,
  mergeSystemPrompt, speechFields, speechPlanSchema, systemPromptOf,
} from "../src/index.js";

const prompt = buildSystemPrompt({ disclosureLine: "Hi, this is an automated assistant.", scriptBody: "Ask about vendors." });

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

  it("breaks a silence before it reads as a dropped call", () => {
    expect(SPEECH_PLAN.silenceTimeoutSeconds).toBeLessThanOrEqual(10);
  });

  it("refuses a plan outside the ranges Vapi accepts", () => {
    expect(() => speechPlanSchema.parse({ ...SPEECH_PLAN, startWaitSeconds: 99 })).toThrow();
    expect(() => speechPlanSchema.parse({ ...SPEECH_PLAN, silenceTimeoutSeconds: 1 })).toThrow();
  });

  it("maps onto the Vapi field names", () => {
    expect(speechFields(SPEECH_PLAN)).toEqual({
      silenceTimeoutSeconds: 7,
      maxDurationSeconds: 480,
      startSpeakingPlan: { waitSeconds: 0.8 },
      stopSpeakingPlan: { numWords: 2, backoffSeconds: 1.5 },
    });
  });
});

describe("the objective", () => {
  it("is the vendor manager's contact details and nothing else", () => {
    expect(OBJECTIVE).toContain("who at this company approves maintenance vendors");
    for (const field of ["name", "job title", "email address", "direct phone number"]) {
      expect(OBJECTIVE).toContain(field);
    }
  });

  it("says plainly that nothing is being sold or booked", () => {
    expect(OBJECTIVE).toContain("not selling");
    expect(OBJECTIVE).toContain("not booking");
  });
});

describe("the conversation rules", () => {
  it("makes answering a question a complete turn", () => {
    expect(CONVERSATION_RULES).toContain("Answering a question is a complete turn");
    expect(CONVERSATION_RULES).toContain("Do not follow an answer with a pitch");
  });

  it("forbids asking the same thing again next turn", () => {
    expect(CONVERSATION_RULES).toContain("do not ask again in your next turn");
    expect(CONVERSATION_RULES).toContain("three times in a row");
  });

  it("forbids one question stacked on another", () => {
    expect(CONVERSATION_RULES).toContain("Ask for one thing at a time");
  });

  it("tells it to repeat from memory rather than calling a tool", () => {
    expect(CONVERSATION_RULES).toContain("Do not call a tool to repeat");
    expect(CONVERSATION_RULES).toContain("sounds like the call has dropped");
  });

  it("requires the spelled-out email read-back at dictation speed", () => {
    expect(CONVERSATION_RULES).toContain("letter by letter");
    expect(CONVERSATION_RULES).toContain("Never read an email address back as a single word");
  });

  it("keeps the packet out of the call unless asked", () => {
    expect(CONVERSATION_RULES).toContain("unless the caller asks for it first");
  });

  it("keeps the truthful-about-being-a-bot rule", () => {
    expect(CONVERSATION_RULES).toContain("Never deny it");
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

  it("refuses to build without a disclosure line", () => {
    expect(() => buildSystemPrompt({ disclosureLine: "", scriptBody: "x" })).toThrow();
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
