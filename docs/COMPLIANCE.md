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

## Opt-out and revocation

- `/tools/opt_out` is synchronous: writes `suppression` (upsert on phone) and `consent_event(revoke)` for every contact carrying the number, then instructs the agent to end the call.
- Revocation is intent-based ("take me off your list", "stop", "don't call here") — Phase 4 wires NLU classification to this tool.
- Truthful answers to "am I talking to a robot?" are hard-coded in the assistant prompt (Phase 4).
- Never enroll voiceprints (BIPA / CUBI).

## Discord meeting capture (added 2026-09-17)

A second recording surface, and a different legal footing from the dial path: these are internal
meetings among people who work together, not calls to strangers, so the TCPA and the DNC registry do
not apply. What does apply is recording consent, and it is handled in code, not by convention.

### The notice

Posted by the bot into the channel it is about to record, **before** the voice connection is opened.
If the post fails, the join fails and nothing is retained — that is what makes it a precondition
rather than a courtesy. Fixed text, in `apps/capture/src/notice.ts`:

> Recording started. This voice channel is being recorded and transcribed by the Transparent
> Maintenance meeting bot, and commitments made here are filed as tasks on the TM-OS board. Leave
> the channel to stop being recorded. Details are pinned in this channel.

### The pinned message (Michael's, not the code's)

Every watched channel must carry a **pinned message** saying it is recorded. The in-channel notice
tells the room what is happening right now; the pin is what someone joining mid-meeting, or reading
back later, can find. Georgia is one-party consent, but the bot is not a party to the conversation
and the audio goes to durable storage and a third-party transcriber, so the notice is given
unconditionally rather than depending on where anyone is sitting. If a participant is ever in a
two-party state (CA, FL, IL, MA, PA, WA), the notice plus the pin is what the consent rests on.

### The CONSENT_EVENT

Written in the same transaction as the `meeting` row, at join:

| Column | Value |
|---|---|
| `event_type` | `grant` |
| `channel` | `discord` |
| `meeting_id` | the meeting (`contact_id` is null — a Discord participant is not a contact) |
| `occurred_at` | the moment the bot joined |
| `capture_artifact` | the notice text **verbatim**, the id of the message that carried it, the guild/channel/session ids, and the member ids present to read it |

Storing the notice verbatim rather than a version number is deliberate: if the wording ever changes,
what a given room was actually told is still recoverable. The table remains append-only — the
immutability trigger from migration `0001` is untouched (rule 4).

### Boundary

`WATCH_CHANNEL_IDS` plus channel-level Connect, and nothing else. The bot never records server-wide;
an empty `WATCH_CHANNEL_IDS` records **nothing** rather than everything, and the adapter refuses to
post into a channel that is not on the list. It holds no privileged intents and never reads message
history. Leaving the channel stops the recording, and when the last non-bot member leaves the
meeting is finalised.

### Retention

Meeting audio is `recording` rows like any other, so `recording_retain_5y` applies and the same
`retention.sweep` job deletes them on the same 5-year clock as call recordings. That is longer than
an internal meeting needs, and it is the conservative direction; narrowing it would mean carving an
exception into a constraint that currently has none.

### Still open

- Voiceprints are never enrolled, here as anywhere (BIPA / CUBI). Speaker attribution comes from
  Discord's own per-user streams, not from recognising anyone's voice.
- No batch STT provider has been chosen, so no meeting audio has left this system yet. When one is
  picked, its data-retention and training terms are a compliance decision, not just a cost one.

## Retention (5 years)

`recording.retain_until ≥ created_at + 5 years` is a DB check constraint. The retention sweeper deletes only rows past `retain_until`. Keep: timestamp, number, line type, consent record relied on, verbatim disclosure, recording, transcript, revocation events — all present in the ERD.

## Before the first real dial (Michael)

- [ ] Telnyx Verified tier; DIDs owned, A-attestation, Free Caller Registry submitted
- [ ] DoNotCallDNC block purchased; written DNC policy on file — **or** `DNC_SCRUB=off` recorded as a counsel-reviewed decision with the B2B-only list policy that justifies it
- [ ] Counsel reviews script, consent language, list policy
- [ ] Texas registration if any TX contacts; GA SB 73 scrub for GA mobiles
- [ ] `DIAL_MODE=verified_only` with `DIAL_ALLOWLIST` = your own numbers first
