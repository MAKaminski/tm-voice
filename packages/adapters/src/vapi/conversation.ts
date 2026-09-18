import { z } from "zod";

/**
 * How Joe talks, in version control.
 *
 * `voice.ts` put how Joe *sounds* under review. This file does the same for how he *behaves* —
 * the system prompt and the call-handling settings — for the same reason: until now both lived
 * only in the Vapi dashboard, so the difference between a call that works and a call that hangs
 * up on a prospect produced no diff, no review and no CI run.
 *
 * Every rule below traces to a specific complaint from a real call. They are written as rules the
 * model must follow rather than as suggestions, because the failures they fix were all the model
 * doing something reasonable-sounding that made the call worse.
 */

/**
 * Vapi ships an ambient "office" loop — keyboard clatter and background chatter — and several of
 * its assistant templates enable it by default to make a bot sound like it is in a call centre.
 * On a real call it just sounds like the caller is being phoned from a noisy room by someone who
 * is not paying attention, and it competes with the agent's own speech.
 *
 * Off. If ambience is ever wanted again it is a reviewed change here, not a dashboard toggle.
 */
export const BACKGROUND_SOUND = "off" as const;

/**
 * Recording has to be ON, and it is a compliance requirement rather than a preference.
 *
 * The fixed disclosure line tells every prospect "This call is being recorded." Until now nothing
 * on the dial path recorded anything — Vapi's recording setting was never configured and never
 * diffed, and no `recording` row was ever written for a call. So the agent was making a statement
 * to the prospect that was not true, and `docs/COMPLIANCE.md`'s commitment to keep the recording
 * for five years had nothing to keep.
 *
 * Owned here so it cannot be switched off in the dashboard without the sync putting it back.
 */
export const RECORDING_ENABLED = true as const;

export const speechPlanSchema = z.object({
  /**
   * How long the caller must be silent before Joe assumes his turn has started. Vapi's default is
   * a fraction of a second, which is what makes an agent feel like it is talking over you and
   * leaves no room to think mid-sentence.
   */
  startWaitSeconds: z.number().min(0).max(5),
  /** Words the caller can say to cut Joe off. Low, so interrupting actually works. */
  interruptWords: z.number().int().min(0).max(10),
  /** How long Joe stays quiet after being interrupted, so a cut-off is not a fight. */
  interruptBackoffSeconds: z.number().min(0).max(5),
  /**
   * Silence before Vapi **ends the call**. It does not prompt Joe to speak — that was the belief
   * behind the original 7s, and it is the opposite of what the field does, so a caller who went
   * quiet to look up an email address was hung up on mid-lookup.
   *
   * Vapi's own default is 30s and its documented floor is 10s, so the old `min(5)` also let us
   * configure a value Vapi would reject.
   */
  silenceTimeoutSeconds: z.number().min(10).max(60),
  /** Hard cap on one call. A vendor-intake call that has run 8 minutes is not going to convert. */
  maxDurationSeconds: z.number().int().min(60).max(3600),
});
export type SpeechPlan = z.infer<typeof speechPlanSchema>;

export const SPEECH_PLAN: SpeechPlan = {
  startWaitSeconds: 0.8,
  interruptWords: 2,
  interruptBackoffSeconds: 1.5,
  /**
   * 20s, not the 7s this was. Being asked for a vendor manager's email or a portal URL sends people
   * to another system to look it up, and that is routinely 10-20 seconds of silence. Below Vapi's
   * 30s default because a caller who has actually walked away should not hold the line for half a
   * minute, and `maxDurationSeconds` is the only other thing that would end it.
   */
  silenceTimeoutSeconds: 20,
  maxDurationSeconds: 480,
};

/**
 * The one thing this call is for.
 *
 * The agent cannot hold an open-ended conversation about maintenance contracts, and trying made
 * it worse: it answered a question and then immediately re-pitched, three times in a row, because
 * nothing told it that answering *was* a complete turn. So the objective is narrowed to the one
 * outcome a scripted call can actually achieve — finding out who approves maintenance vendors and
 * how to reach them — and everything else is explicitly out of scope.
 */
export const OBJECTIVE = `Your only goal is to find out who at this company approves maintenance vendors, and how to reach them: their name, their job title, their email address, and a direct phone number if they have one.

That is the whole job. You are not selling anything on this call. You are not booking anything. You are not explaining the service in depth.`;

export const CONVERSATION_RULES = `## How to talk

Answer the question you were asked, then stop talking. Answering a question is a complete turn. Do not follow an answer with a pitch, a request, or another question in the same turn — say your answer and wait for them to speak.

Ask for one thing at a time. Never stack two questions into one turn.

If you have already asked for something and not got it, do not ask again in your next turn. Wait for them to bring it up, or let the call end. Asking the same thing three times in a row is worse than not asking at all.

If they ask you something you do not know, say you do not know and that someone from the office can answer it. Do not guess, and do not change the subject to what you want.

If they ask whether you are a person, a bot, a recording, or AI: tell them plainly that you are an automated assistant. Never deny it, never deflect.

If they say stop, take me off your list, do not call here, or anything meaning the same thing: call the opt_out tool immediately, apologise briefly, and end the call. Do not try to keep them on the line.

## Repeating yourself

If they ask you to repeat something, repeat it straight away using what you already have. Do not call a tool to repeat something you have already said — you already know it, and the pause while you look it up sounds like the call has dropped.

If you need a moment for any reason, say so out loud before you go quiet.

## Email addresses

Email addresses are the single hardest thing to get right on a phone call, and getting one wrong wastes the whole call.

When they give you an email address, call the capture_contact tool with it. The tool returns a spelled-out version in a "say" field. Read that field back exactly as it is written, letter by letter, and do not speed up. Then ask them to confirm it is right.

If they correct you, call capture_contact again with the corrected address and read the new spelling back the same way.

Never read an email address back as a single word. Never read one back faster than you would say a phone number to someone writing it down.

## Out of scope

Do not offer the onboarding packet, a walkthrough, a quote, or an appointment unless the caller asks for it first. If they do ask, answer briefly and then get back to confirming the contact details.`;

/**
 * What Joe may state about the company, and when.
 *
 * The agent shipped with no facts at all. Its own rule is to say it does not know what it does not
 * know, so on a vendor-intake call it answered "I don't know" to every qualifying question — are you
 * licensed, are you lead-safe certified, what do you self-perform, where do work orders go — and the
 * call ended before it could ask for the one thing it exists to collect. Fixing the objective (item 7)
 * without this only narrowed the goal; it did not let the agent reach it.
 *
 * The rows come from TM-OS (decision 0031), not from this file, because a person must be able to
 * revoke or correct a claim without a deploy. Only rows a person marked `sayable` arrive here at all.
 */
export const factsSchema = z.object({
  licences: z.array(z.object({
    kind: z.string(), name: z.string(), number: z.string(), holder: z.string(),
    expires_on: z.string().nullable(),
  })),
  facts: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
});
export type Facts = z.infer<typeof factsSchema>;

/** ISO date already past at `now`. A null expiry is a registration number: it never lapses. */
function expired(expires_on: string | null, now: Date): boolean {
  if (!expires_on) return false;
  return Date.parse(`${expires_on}T23:59:59Z`) < now.getTime();
}

/**
 * Renders the sayable facts, dropping any licence that has lapsed.
 *
 * This filter is the most important line here. A certificate is a claim about the present tense: the
 * lead-safe firm certificate expires 2026-12-14, and an agent still telling a property manager the
 * company is a certified renovation firm on 2026-12-15 is making a false statement to someone who
 * may rely on it. TM-OS files a renewal card 30 days out; if that card is missed, the agent must go
 * quiet on the claim rather than carry it forward.
 *
 * Nothing here claims insurance. Licences and insurance are different things, and the company's auto
 * liability certificate is expired — so "we are licensed" must never be rendered as "we are covered".
 */
export function renderFacts(input: Facts, now: Date): string {
  const { licences, facts } = factsSchema.parse(input);
  const live = licences.filter((l) => !expired(l.expires_on, now));
  const lines: string[] = [
    "## What you may state about the company",
    "",
    "These are the only company facts you may give out. If you are asked something that is not here, say you do not know and that someone from the office can answer it. Never guess a number, a date or an address.",
    "",
  ];
  if (facts.length) {
    for (const f of facts) lines.push(`- ${f.label}: ${f.value}`);
    lines.push("");
  }
  if (live.length) {
    lines.push("Licences and certifications, current as of this call:");
    // A holder that already ends in a full stop ("Transparent Maintenance Inc.") must not get a
    // second one: this string is read aloud, and the TTS engine does not silently swallow "..".
    for (const l of live) lines.push(`- ${l.name}, number ${l.number}, held by ${l.holder.replace(/\.$/, "")}.`);
    lines.push("");
  }
  lines.push(
    "Say a licence number only if you are asked whether the company is licensed or certified. Read it back the way you read an email address: slowly, character by character, never as one word.",
    "",
    "Do not say the company is insured, and do not describe its insurance. Being licensed and being insured are different things and you only know about the licences above. If you are asked about insurance, certificates of insurance or being bonded, say someone from the office will send the certificate.",
  );
  return lines.join("\n");
}

export const buildSystemPromptSchema = z.object({
  /** SCRIPT_VERSION.disclosure_line, verbatim. Rule 10: it is the first utterance, not a summary. */
  disclosureLine: z.string().min(1),
  /** SCRIPT_VERSION.body — the campaign's own framing, which varies per script version. */
  scriptBody: z.string().min(1),
  /** Sayable company facts from TM-OS. Required: an agent with no facts cannot clear a vendor-intake call. */
  facts: factsSchema,
  /** Evaluated against each licence's expiry, so a lapsed certificate is never stated. */
  now: z.date(),
});

/**
 * Assembles the system prompt from the reviewed rules plus the active script version, so a script
 * change in the database still flows through and the conversation rules cannot be edited away.
 */
export function buildSystemPrompt(input: z.infer<typeof buildSystemPromptSchema>): string {
  const { disclosureLine, scriptBody, facts, now } = buildSystemPromptSchema.parse(input);
  return [
    "You are Joe, an automated assistant calling on behalf of Transparent Maintenance, a property maintenance company in Atlanta.",
    "",
    "## Your goal",
    "",
    OBJECTIVE,
    "",
    `Campaign context: ${scriptBody}`,
    "",
    renderFacts(facts, now),
    "",
    CONVERSATION_RULES,
    "",
    "## The opening line",
    "",
    `Your first sentence is fixed and has already been spoken for you: "${disclosureLine}"`,
    "",
    "It is a legal notice, not a greeting. Never repeat it, never paraphrase it, and never introduce yourself a second time.",
  ].join("\n");
}
