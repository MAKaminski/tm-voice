# TM Voice

An outbound calling agent for Transparent Maintenance, a residential maintenance contractor in
metro Atlanta.

It calls property management companies to find out who approves maintenance vendors and how to
become one. The agent is called Joe. It does not sell, quote or book work — it finds the right
person, learns what the vendor application needs, and hands that to a human to follow up.

It also records and transcribes internal Discord meetings, filing what was agreed as tasks in
TM-OS.

## What state it is in

Honest summary, because "it's built" and "it's working" are different things.

| | |
|---|---|
| Calls are placed through | Telnyx (the phone number) and Vapi (the conversation) — both live |
| Currently dialling | `verified_only` — real calls, but only to numbers that have passed the checks |
| Not yet live | Call recordings are not being stored, and the agent cannot yet quote the company's own licence numbers |
| Known problem | The agent's voice fails to render on some calls. See `docs/RUNBOOK.md` § 7b |

## Getting it running

You need Node 22+ and pnpm 9+.

```bash
pnpm install
cp infra/env.example .env        # then fill it in — see docs/CREDENTIALS.md
pnpm db:migrate                  # create the tables
pnpm db:seed                     # sample campaign, people and phone numbers
pnpm dev                         # starts every service
```

With no vendor keys set, every outside service answers with a fake, so you can run the whole thing
locally without touching a real phone line. The `DIAL_MODE` setting decides whether calls are real:
`dry_run` never dials, `verified_only` dials checked numbers, `live` dials anything that passes the
checks.

Before pushing, run `pnpm run ci`. It is the same check that runs on every pull request.

## How the pieces fit

```
apps/console    the web screens people use        (Next.js)
apps/api        the web API and incoming webhooks (Hono)
apps/worker     everything that happens in the background (job queue)
apps/capture    joins Discord calls and records them

packages/db          the database and its schema
packages/compliance  the rules about who may be called
packages/adapters    the only place outside services are talked to
packages/shared      config and job plumbing
```

The shape is deliberate: **every outside service is reached through `packages/adapters` and nowhere
else**, and **every action that changes something outside this system is a queued job**, so it can
be retried and replayed rather than lost.

## Rules that are not negotiable

These are enforced in code and in CI, not by convention. The full list is in `CLAUDE.md`.

- **No call is placed without passing the checks first.** Suppression, do-not-call, consent, line
  type, time of day and daily caps are all decided in one database transaction before anything
  reaches the phone network. There is no code path around it.
- **Consent records are never edited or deleted.** They are the evidence that a number was lawfully
  called.
- **Opt-outs are keyed to the phone number**, never to a person, so they survive a contact being
  re-imported or merged.
- **The legal disclosure is always the first thing said**, word for word.
- **Recordings are kept for five years**, then deleted automatically.

## Where to look

| If you want to | Read |
|---|---|
| Understand how it all fits together | `docs/ARCHITECTURE.md` |
| Run it, fix it, or change how the agent behaves | `docs/RUNBOOK.md` |
| Know what the compliance obligations actually are | `docs/COMPLIANCE.md` |
| Set up an account or rotate a key | `docs/CREDENTIALS.md` |
| See the database tables | `docs/ERD.md` |
| See it as a picture | `docs/diagrams/` |

Two documents are generated from the code and checked in CI — `docs/ERD.md` and the voice settings
block in `docs/ARCHITECTURE.md`. If you change the database schema or how the agent sounds, run
`pnpm erd:write` or `pnpm voice:write` and commit the result, or CI will fail.

## Placing a test call

Open the console's **Calls** tab. Enter a number, confirm you are allowed to call it, and it goes
through the real dialler — same checks, same records — rather than around it. The same page shows
every call placed and every one the checks refused, with the reason.

Details, and what to check when a call does not go through, are in `docs/RUNBOOK.md` § 7a2.

## Commands

| | |
|---|---|
| `pnpm dev` | run everything locally |
| `pnpm run ci` | the full check — run this before pushing |
| `pnpm db:migrate` | apply database changes |
| `pnpm db:seed` | load sample data |
| `pnpm replay <queue> <job_id>` | re-run a job that failed |
