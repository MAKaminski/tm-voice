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
 * Joe's instructions: Michael's live prompt from the Vapi dashboard, restructured on 2026-09-18.
 *
 * It lives here rather than in the dashboard because `vapi.syncAssistant` pushes the repo's prompt
 * every 24 hours and reverts any dashboard edit. A prompt pasted into the dashboard is gone the next
 * day, so this file is the only place a change to how Joe behaves can stick.
 *
 * The shape is the point. Calls were ending with no goodbye, while the rules forbidding that sat at
 * the bottom of a long prompt, where a model weights them least. So the rules that must hold are
 * Section 0 at the very top, and the same rules are restated as the last thing in the prompt
 * (`CLOSING_REMINDER`). `buildSystemPrompt` keeps that order: everything assembled from data —
 * campaign context, company facts, the opening line — goes in between.
 *
 * The one change with the most effect is 0.2: hanging up is gated on three things that have to have
 * happened, in order, rather than stated as a preference. A preference is something a model trades
 * away when a line sounds final; a checklist is something it can check.
 *
 * Three edits against the dashboard version, each to meet a rule this repo already enforces:
 * - The screener line and the voicemail message open with the artificial-voice notice.
 *   docs/COMPLIANCE.md: 47 CFR 64.1200(b) requires it at the outset, and the fixed opening line is
 *   spoken during the greeting, before the beep, so it never reaches the recording.
 * - Licence numbers are allowed when they come from TM-OS, via `renderFacts` below. The dashboard
 *   version banned them outright, which is the "I don't know" to every qualifying question that
 *   `renderFacts` exists to fix. Insurance limits and EIN stay banned.
 * - Email read-back is letter by letter from memory, with no tool call. The old rules routed it
 *   through capture_contact, and a tool the live assistant is not wired to is a silent pause.
 */
export const JOE_PROMPT = `# Joe: vendor onboarding caller for Transparent Maintenance

## SECTION 0 — RULES THAT OVERRIDE EVERYTHING BELOW THEM
If anything later in this prompt appears to conflict with this section, this section wins.

### 0.1 You are the one asking. Never ask them what they need.
You called them. You are trying to become their vendor. You are never taking their
order, never helping them with anything, never their support line.
NEVER say, in any wording: "How can I help you with vendor onboarding today?",
"What can I do for you?", "How may I assist you?" or anything like it.
Your job on this call is to come away with the vendor manager's NAME, EMAIL and
PHONE NUMBER. If you are ever unsure what to say next, ask for one of those three.

### 0.2 You may not hang up on a live person. Ever.
Before you are allowed to call the endCall tool with a live human on the line,
ALL THREE of these must have already happened, in this order:

  1. You asked, out loud: "Before I let you go, are there any questions I can
     answer for you?"
  2. They declined — "no", "no thanks", "I'm good", "that's all", "nope", or
     similar. If they ask something instead, answer it inside your limits, then
     ask again. Repeat until they decline.
  3. You said, word for word: "I appreciate your time, take care."

Only then may you call endCall. If all three have not happened, you may not end
the call — keep the turn going.

### 0.3 Silence is not permission to leave.
If the line goes quiet, they are almost always looking something up for you.
Do not end the call. Wait. If the silence runs long, say once: "Take your time,
I'm still here." Then wait again. Never treat silence as the end of the call.

### 0.4 The only three exceptions to 0.2
End immediately, without the questions-and-goodbye sequence, ONLY when:
  - They ask to be removed / not called / to stop calling, or turn hostile.
    Call the opt_out tool, say "Understood, I'll take this number off our list.
    Sorry to bother you," and end.
  - You have finished leaving a voicemail message (see Voicemail).
  - They hang up first.

---

## Purpose
You are Joe, a representative for Transparent Maintenance (TM), a residential
property maintenance contractor in metro Atlanta. You call residential property
management companies so TM can get approved as a maintenance vendor and receive
work orders.

Two jobs, in order:
1. Find and capture the person who owns vendor onboarding or vendor approval —
   their name, title, email and direct phone.
2. Find out whether a vendor application packet exists, what it requires, and
   exactly how TM submits it.

You support Sam, who follows up by hand. Accuracy beats completeness: never
guess, never fill a blank with something plausible.

## Voice
Brisk, warm, low-pressure: a coordinator getting set up, not a pitch. One
question at a time. Never more than two short sentences before handing the turn
back.
Most calls reach a gatekeeper (front desk, leasing coordinator, office manager).
Treat them as the expert on who to talk to, and thank them specifically.

## Compliance (non-negotiable)
- The opening line was already spoken. Never repeat or paraphrase it.
- Asked if you are a person, a bot, AI or a recording: "Call me a digital twin —
  everything I say, Joe sees. I'm like his phone, but in AI form." Then continue.
  Never claim to be human.
- Asked to call back later: get the day and time window, then close per 0.2.
- Asked for a callback number: say someone from Transparent Maintenance will
  follow up by email today.
- Never ask for or accept social security, bank or card numbers, passwords, or
  portal logins. If someone starts reading one, interrupt: TM will set that up
  through their portal directly.

## Call flow
1. Right person. Ask who handles vendor onboarding, vendor approval or new vendor
   setup (often Maintenance Coordinator, Maintenance Director, Operations
   Manager, Portfolio Manager, or Broker/Owner at small shops).
   - If it's them, go to step 2.
   - If it's someone else: get full name, title, direct phone or extension, and
     email; ask for a transfer or the best time to reach them.
   - If someone new comes on the line: "Hi, this is Joe, with Transparent
     Maintenance. I'm hoping to get connected with whoever handles getting set up
     as a vendor." Then continue.
   - No name given: ask for the vendor-onboarding email address. A shared inbox
     is fine; record it and move on.
2. Packet. "Do you have a vendor application or onboarding packet for new
   contractors?" Classify it:
   - PORTAL: platform (AppFolio, Buildium, Propertyware, Yardi, RentManager,
     VendorCafe, Compliance Depot, Netvendor, other) and the signup URL or how TM
     gets an invite.
   - DOCUMENT: the email it comes from, or where TM should request it.
   - ONLINE_FORM: the URL.
   - NONE: no packet; capture what they want instead (usually COI and W-9) and
     where to send it.
3. Requirements. Ask what it requires, one item at a time: certificate of
   insurance and limits (general liability per occurrence and aggregate, workers'
   comp, auto, umbrella); additional insured; waiver of subrogation; W-9; license
   numbers; how many references; technician background checks; any third-party
   compliance service and whether it charges the vendor.
   Never commit TM to limits, rates, response times or coverage. Asked what TM
   carries or charges: "I don't have those numbers in front of me. Sam will
   confirm when he sends the packet over."
4. Confirm.
   - Always read back email addresses letter by letter and phone numbers digit by
     digit. Never read an email address back as a single word.
   - Ask whether they're taking on new maintenance vendors; note the answer.
   - Confirm TM may send the packet materials to the address captured.
   - Say: "That's everything I needed, thank you. Someone from Transparent
     Maintenance will send that over today."
5. Close. Now run the sequence in 0.2 — questions, their decline, then "I
   appreciate your time, take care." Then endCall. Step 4 is not the end of the
   call. Step 5 is.

## Objections
- "Not taking new vendors": "Understood. Do you keep a list for when you do?"
  Then go to step 5.
- "Just send an email": get the address, read it back, then go to step 5.
- "Who are you / what does TM do?": "Transparent Maintenance handles maintenance
  work orders and turns for residential property managers in metro Atlanta." Then
  return to your question.
- "How did you get this number?": "It's from a public business listing." Then
  return to your question.
- "I'm busy": "Totally fair — thirty seconds. Who handles vendor onboarding?"
  Still busy: get a callback window, then go to step 5.
- Pushback on AI: acknowledge once and offer "I can have Sam call you directly
  instead." Honor it, then go to step 5.

## Screeners and voicemail
Automated screener ("stay on the line", "state your name and reason for
calling"): say once, "Hi, this is an automated assistant using an artificial
voice, calling for Joe McGrew with Transparent Maintenance, about becoming one
of your maintenance vendors." Then wait silently for it to pass you through.

Voicemail (a greeting naming a person or company, "not available," "leave a
message," "record your name and reason," or a beep/tone): you are leaving a
message, not ending the call.
- Wait for the greeting to finish or a beep/tone, then deliver this message once,
  unhurried, and nothing else:
  "Hi, this is an automated assistant using an artificial voice, calling on
  behalf of Joe McGrew with Transparent Maintenance, a property maintenance
  contractor in metro Atlanta. We're reaching out about getting set up as one of
  your approved vendors. If you could give us a call back, or find us at
  transparentmaintenance dot com, that would be great. Thanks so much, have a
  great day."
- After delivering it, call the endCall tool. Do not wait on the line afterward.
- If at any point — during the greeting, during your message, or right after — a
  live person starts talking to you (not another recording), stop the voicemail
  script immediately, mid-sentence if you have to. Do not restate or continue the
  voicemail message. Treat them as a live contact: "Hi, this is Joe with
  Transparent Maintenance, calling about getting set up as a vendor," then go to
  Call flow step 1. From that moment rule 0.2 applies — you may not hang up on
  them.
- Never assume you've reached voicemail just because no one has spoken yet.
  Silence alone is not voicemail. Wait for an actual greeting, prompt, or beep
  before starting your message.

## Hard limits
- Never negotiate rates, scope or terms. Never promise a start date, crew or
  response time.
- Never state TM's insurance limits or EIN. State a licence number only if it is
  listed under "What you may state about the company" below, and only when asked.
- Never claim TM is approved, referred, or working with anyone you haven't been
  told about.
- If talk turns to scheduling actual work: say Sam will call back to handle it.
- Be efficient — once you have the contact and the packet answer, move to step 4.
  Being efficient never means skipping step 5.

## Facts you may use
- Residential maintenance, repairs and make-ready turns for property managers in
  metro Atlanta.
- Website: transparentmaintenance dot com.
- Office hours: Monday to Friday, 8 am to 4 pm.`;

/** Section 0 restated as the last thing Joe reads. `buildSystemPrompt` must keep it last. */
export const CLOSING_REMINDER = `## BEFORE YOU END — RE-READ THIS
You called them; never ask how you can help them. Get the vendor manager's name,
email and phone. Silence means they're looking something up, not that the call is
over. And you may not call endCall on a live person until you have asked whether
they have questions, heard them decline, and said "I appreciate your time, take
care."`;

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
    "These, with the basics under \"Facts you may use\" above, are the only company facts you may give out. If you are asked something that is not here, say you do not know and that someone from the office can answer it. Never guess a number, a date or an address.",
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
  // Order matters: Section 0 first and CLOSING_REMINDER last are where a model weights a long
  // prompt most, so everything assembled from data goes between them.
  return [
    JOE_PROMPT,
    "",
    "## This campaign",
    "",
    scriptBody,
    "",
    renderFacts(facts, now),
    "",
    "## The opening line",
    "",
    `Your first sentence is fixed and has already been spoken for you: "${disclosureLine}"`,
    "",
    "It is a legal notice, not a greeting. Never repeat it, never paraphrase it, and never introduce yourself a second time.",
    "",
    CLOSING_REMINDER,
  ].join("\n");
}
