# Compliance — TM Voice

The FCC classifies AI-generated voice as an "artificial voice" under the TCPA. Calls to wireless numbers need prior express written consent regardless of B2B framing. Everything below is enforced in code (`packages/compliance`), not in the UI.

## Target surface policy (settled 2026-09-08)

**Both, segmented.** Launch with `COMPLIANCE_TARGET_SURFACE=landline_only`. Mobiles are dialed only after Phase 7 ships a consent-capture flow that writes `consent_event(grant)` with a `capture_artifact`, and only after the variable is flipped to `consented_mobile`. The gate implements both modes today.

## Pre-dial gate (`gate.ts`), in order — first failure wins

| # | Check | `gate_result` | Source of truth |
|---|---|---|---|
| 1 | Surface: `landline_only` → `line_type = landline`; `consented_mobile` → wireless needs a `grant` newer than any `revoke`. MA excluded unless `ALLOW_MA_RECORDING=true` | `surface` | `contact.line_type`, `consent_event` |
| 2 | Suppression by `phone_e164` (never by contact) | `suppressed` | `suppression` |
| 3 | DNC federal/state (DoNotCallDNC; cached 30 days on the contact). **Lookup skipped when `DNC_SCRUB=off`; a cached hit still blocks** | `dnc` | `contact.dnc_*`, dnc adapter |
| 4 | Calling window 08:00–21:00 local; FL cutoff 20:00; CT start 09:00 | `window` | `contact.timezone`, `contact.state` |
| 5 | Per-DID daily cap | `did_cap` | `did.daily_cap`, `call` |
| 6 | Attempt cap per contact per campaign (default 3) | `attempts` | `call_task.attempt_no`, `campaign.max_attempts` |

`gate_result` is written in the same transaction that claims the task (`SELECT … FOR UPDATE SKIP LOCKED`). Only `pass` reaches the vapi/telnyx adapters, and those adapters independently enforce `DIAL_MODE`.

## DNC scrub flag (`DNC_SCRUB`, decided 2026-09-13)

`DNC_SCRUB=required` is the default and what the gate table above describes. `DNC_SCRUB=off` is a deliberate go-live decision to dial before a DoNotCallDNC block has been purchased. What it changes, precisely:

| | `required` | `off` |
|---|---|---|
| Registry lookup on a stale or never-checked contact | Yes, via the dnc adapter | **No** |
| `DNC_API_KEY` in the dial-path keys the loader demands | Yes | **No** |
| A `federal`/`state` hit already cached on `contact.dnc_*` | Blocks (`dnc`) | **Still blocks** — the flag removes the lookup, not the knowledge |
| Visibility | — | `warn` at api and worker boot; `dnc_scrub: "off"` on `/health`; red pill on the console dashboard |

The basis for running `off`: the pilot list is property-management **businesses** reached on landlines, and the TSR's National DNC provisions cover residential subscribers, not business-to-business calls. That exemption is narrower than it sounds — a sole proprietor's line can be a residential number, and state lists differ — so `off` is a decision that belongs on the counsel checklist below, not a default. Flip it back to `required` the day a lookup block is bought; nothing else changes.

## Opening disclosure (fixed, first utterance)

Stored in `script_version.disclosure_line`; the seed's version:

> Hi, this is an automated assistant using an artificial voice, calling on behalf of Transparent Maintenance about property maintenance services. This call is being recorded. You can say stop at any time to end the call and be removed from our list.

Covers artificial-voice notice, company name, purpose, recorded-line notice, and opt-out instruction in one utterance (47 CFR 64.1200(b), CA AB 2905, CA B.O.T. Act, Utah). Do not paraphrase. `assertFirstUtterance()` verifies it in Phase 4.

### "Does it have to say it's an AI bot at the start?" — yes

This comes up every time someone hears the opening line, so here is the answer once, clause by
clause. Nothing in it is a style choice and nothing in it can be dropped to make the call warmer.

| Clause | Why it is there | Can it go? |
|---|---|---|
| "an automated assistant using an artificial voice" | The FCC's February 2024 ruling makes an AI-generated voice an "artificial voice" under the TCPA. 47 CFR 64.1200(b)(1) requires the caller to state at the **outset** that the call is from an artificial or prerecorded voice. California's B.O.T. Act and Utah's AI disclosure law separately require a bot to say it is a bot. | **No.** Required at the start, by name. |
| "on behalf of Transparent Maintenance" | Same rule: the identity of the business must be stated at the beginning. | **No.** |
| "about property maintenance services" | 64.1200(b)(2) — the purpose of the call. | **No.** |
| "This call is being recorded." | Two-party recording-consent states (CA, FL, IL, MA, PA, WA). The pilot list is Georgia, which is one-party, but a call to a business reaches whoever picks up and the line is recorded to durable storage, so the notice is given unconditionally. | Only by geofencing the campaign, which costs more than the sentence does. |
| "You can say stop at any time…" | The TSR requires a prompt, cost-free opt-out mechanism, and this is what makes the intent-based opt-out in `/tools/opt_out` defensible. | **No.** |

So the answer to the feedback is: it stays. What is worth knowing is that saying it up front is
also the cheapest part of the call — a caller who is going to object to a bot will object either
way, and doing it in the first sentence means they object before anyone's time is spent.

**If the length is the real complaint**, the room to move is in the wording, not the content, and
it is a counsel decision rather than an engineering one. Any revision has to keep all five clauses
above, goes in `script_version.disclosure_line` as a **new row**, and only becomes live when that
row is marked active — `vapi.syncAssistant` then pushes it verbatim. Do not edit the line in the
Vapi dashboard: the sync reverts it within a day and the revert is logged.

## Opt-out and revocation

- `/tools/opt_out` is synchronous: writes `suppression` (upsert on phone) and `consent_event(revoke)` for every contact carrying the number, then instructs the agent to end the call.
- Revocation is intent-based ("take me off your list", "stop", "don't call here") — Phase 4 wires NLU classification to this tool.
- Truthful answers to "am I talking to a robot?" are hard-coded in the assistant prompt (Phase 4).
- Never enroll voiceprints (BIPA / CUBI).

## Retention (5 years)

`recording.retain_until ≥ created_at + 5 years` is a DB check constraint. The retention sweeper deletes only rows past `retain_until`. Keep: timestamp, number, line type, consent record relied on, verbatim disclosure, recording, transcript, revocation events — all present in the ERD.

## Before the first real dial (Michael)

- [ ] Telnyx Verified tier; DIDs owned, A-attestation, Free Caller Registry submitted
- [ ] DoNotCallDNC block purchased; written DNC policy on file — **or** `DNC_SCRUB=off` recorded as a counsel-reviewed decision with the B2B-only list policy that justifies it
- [ ] Counsel reviews script, consent language, list policy
- [ ] Texas registration if any TX contacts; GA SB 73 scrub for GA mobiles
- [ ] `DIAL_MODE=verified_only` with `DIAL_ALLOWLIST` = your own numbers first
