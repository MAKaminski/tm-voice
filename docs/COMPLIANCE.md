# Compliance — TM Voice

The FCC classifies AI-generated voice as an "artificial voice" under the TCPA. Calls to wireless numbers need prior express written consent regardless of B2B framing. Everything below is enforced in code (`packages/compliance`), not in the UI.

## Target surface policy (settled 2026-09-08)

**Both, segmented.** Launch with `COMPLIANCE_TARGET_SURFACE=landline_only`. Mobiles are dialed only after Phase 7 ships a consent-capture flow that writes `consent_event(grant)` with a `capture_artifact`, and only after the variable is flipped to `consented_mobile`. The gate implements both modes today.

## Pre-dial gate (`gate.ts`), in order — first failure wins

| # | Check | `gate_result` | Source of truth |
|---|---|---|---|
| 1 | Surface: `landline_only` → `line_type = landline`; `consented_mobile` → wireless needs a `grant` newer than any `revoke`. MA excluded unless `ALLOW_MA_RECORDING=true` | `surface` | `contact.line_type`, `consent_event` |
| 2 | Suppression by `phone_e164` (never by contact) | `suppressed` | `suppression` |
| 3 | DNC federal/state (DoNotCallDNC; cached 30 days on the contact) | `dnc` | `contact.dnc_*`, dnc adapter |
| 4 | Calling window 08:00–21:00 local; FL cutoff 20:00; CT start 09:00 | `window` | `contact.timezone`, `contact.state` |
| 5 | Per-DID daily cap | `did_cap` | `did.daily_cap`, `call` |
| 6 | Attempt cap per contact per campaign (default 3) | `attempts` | `call_task.attempt_no`, `campaign.max_attempts` |

`gate_result` is written in the same transaction that claims the task (`SELECT … FOR UPDATE SKIP LOCKED`). Only `pass` reaches the vapi/telnyx adapters, and those adapters independently enforce `DIAL_MODE`.

## Opening disclosure (fixed, first utterance)

Stored in `script_version.disclosure_line`; the seed's version:

> Hi, this is an automated assistant using an artificial voice, calling on behalf of Transparent Maintenance about property maintenance services. This call is being recorded. You can say stop at any time to end the call and be removed from our list.

Covers artificial-voice notice, company name, purpose, recorded-line notice, and opt-out instruction in one utterance (47 CFR 64.1200(b), CA AB 2905, CA B.O.T. Act, Utah). Do not paraphrase. `assertFirstUtterance()` verifies it in Phase 4.

## Opt-out and revocation

- `/tools/opt_out` is synchronous: writes `suppression` (upsert on phone) and `consent_event(revoke)` for every contact carrying the number, then instructs the agent to end the call.
- Revocation is intent-based ("take me off your list", "stop", "don't call here") — Phase 4 wires NLU classification to this tool.
- Truthful answers to "am I talking to a robot?" are hard-coded in the assistant prompt (Phase 4).
- Never enroll voiceprints (BIPA / CUBI).

## Retention (5 years)

`recording.retain_until ≥ created_at + 5 years` is a DB check constraint. The retention sweeper deletes only rows past `retain_until`. Keep: timestamp, number, line type, consent record relied on, verbatim disclosure, recording, transcript, revocation events — all present in the ERD.

## Before the first real dial (Michael)

- [ ] Telnyx Verified tier; DIDs owned, A-attestation, Free Caller Registry submitted
- [ ] DoNotCallDNC block purchased; written DNC policy on file
- [ ] Counsel reviews script, consent language, list policy
- [ ] Texas registration if any TX contacts; GA SB 73 scrub for GA mobiles
- [ ] `DIAL_MODE=verified_only` with `DIAL_ALLOWLIST` = your own numbers first
