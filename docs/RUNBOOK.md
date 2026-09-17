# Runbook — TM Voice

What Michael pastes, where, and how to prove it landed. Owner identity for every vendor account: `michael@transparentmaintenance.com`. Secrets go in 1Password vault **"TM Voice"** and Railway variables — never in the repo. The variable manifest is `infra/env.example` (named without the leading dot because local hooks deny `.env.*` paths; copy it to `.env` for local dev).

Status as of 2026-09-17: Phases 0–2 built and green locally with every vendor mocked, plus the Discord meeting-capture pipeline (§ 6b), whose four adapters are also mocked and whose capture service has never run against a live Discord call. Nothing has been deployed and no account has been created by Claude Code.

## 0. Two five-minute checks that can invalidate a sprint (do first)

| # | Check | Where | If no |
|---|---|---|---|
| 1 | Housecall Pro can mint an API key on your MAX plan | https://pro.housecallpro.com/pro/settings/api (Admin → My Apps → App Store → API Key Management) | availability service falls back to manual technician entry; fulfillment to HCP blocked |
| 2 | Apollo plan can mint a **Master API key** | https://app.apollo.io/#/settings/integrations/api | call logging (`POST /phone_calls`) is impossible; Phase 5 needs a plan change |
| 3 | **Start Telnyx KYC today** (multi-day human review) | https://portal.telnyx.com/#/app/account/verifications | first real outbound call is gated |

## 1. Local run (no accounts needed)

```bash
cp infra/env.example .env   # then set DATABASE_URL=pglite:./.data/pglite and any INTERNAL_API_TOKEN ≥16 chars
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm --filter @tm/api dev      # http://localhost:8787/health → 8 vendors, all mode=mock
pnpm --filter @tm/console dev  # http://localhost:3000/book/seed-booking-token-0001
```

Worker needs Redis (`docker compose up -d` when Docker is available, then `pnpm --filter @tm/worker dev`). Without Redis the api runs `availability.materialize` inline; `dial.claim` is exercised by `apps/worker/test/dial.test.ts`.

## 2. GitHub (blocked: needs your account — must be PRIVATE)

Your personal repos default to public. Create this one private:

```bash
gh repo create MAKaminski/tm-voice --private --source=. --remote=origin --push
```

CI (`.github/workflows/ci.yml`) runs `pnpm run ci` on push and PR: typecheck, lint, tests, ERD check, build.

## 3. Railway (blocked: CLI is logged out)

```bash
railway login
railway init -n tm-voice
railway add --database postgres
railway add --database redis
```

Then create three services from this repo (dashboard → New → GitHub repo, or `railway up` three times with `--service api|worker|console`), each with its Dockerfile from `infra/railway.json`. Set variables per service (Railway → project → service → Variables):

| Variable | api | worker | console | Value source |
|---|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | | Postgres plugin reference `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | ✓ | ✓ | | Redis plugin reference `${{Redis.REDIS_URL}}` |
| `INTERNAL_API_TOKEN` | ✓ | | ✓ | `openssl rand -hex 24` → 1Password "TM Voice / internal" |
| `API_BASE_URL` | | | ✓ | api service public domain |
| `APP_BASE_URL` | ✓ | | ✓ | console public domain |
| `DIAL_MODE` | ✓ | ✓ | | `dry_run` until §6 |
| `COMPLIANCE_TARGET_SURFACE` | ✓ | ✓ | | `landline_only` |
| `AUTO_BOOK` | ✓ | | | `false` |
| `NODE_ENV` | ✓ | ✓ | ✓ | `production` |

Run migrations once from your machine against the Railway Postgres: `DATABASE_URL=<railway url> pnpm db:migrate && pnpm db:seed`. Verify: `curl https://<api-domain>/health` returns `ok:true`, `dial_mode:"dry_run"`, 8 vendors `mode:"mock"`.

## 4. Vendor keys — paste list (each → 1Password "TM Voice" item → Railway variable on api + worker)

**Canonical locations live in `docs/CREDENTIALS.md`** — exact portal paths, which values you invent
rather than find, and the rotation procedure. The table below is the paste order; when a URL here and
there disagree, `docs/CREDENTIALS.md` wins.

| # | Variable(s) | Get it here | Notes |
|---|---|---|---|
| 1 | `HCP_API_KEY` | https://pro.housecallpro.com/pro/settings/api | Set and verified (Bearer). Webhooks are optional until a signing secret exists — see `docs/CREDENTIALS.md`. Each account you want the agent to book for needs `account.hcp_customer_id`; `createJob` refuses without it. |
| 2 | `APOLLO_API_KEY` | https://app.apollo.io/#/settings/integrations/api | Master key. |
| 3 | `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_PUBLIC_KEY` | https://portal.telnyx.com/#/app/api-keys · https://portal.telnyx.com/#/app/next/call-control/applications · https://portal.telnyx.com/#/app/account/public-key | `TELNYX_CONNECTION_ID` is the **Application ID** of a Voice API Application, *not* a SIP Connection — `#/app/connections` is the wrong page. $10 top-up; KYC → Verified (Account Settings → Account Level); buy first DID at https://portal.telnyx.com/#/app/numbers/search-numbers and submit to https://www.freecallerregistry.com/fcr/ |
| 4 | `VAPI_PRIVATE_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_ASSISTANT_ID` | https://dashboard.vapi.ai/org/api-keys · **you invent the secret** · https://dashboard.vapi.ai/assistants | `VAPI_WEBHOOK_SECRET` is not on any page: generate a string, put it in a Vapi *Bearer Token* Custom Credential selected under Assistant → Advanced → Webhook Server → Authorization, and paste the same string here. Vapi sends it as `X-Vapi-Secret`. The assistant's `firstMessage` must equal `SCRIPT_VERSION.disclosure_line` — the seeded *Riley* demo assistant does not. **Server URL = `https://<api-domain>/webhooks/vapi`** — assistant-level, and NOT `/tools`. The per-tool URLs are `/tools/<tool_name>`. Setting the assistant's Server URL to `/tools` sends every end-of-call report to a 404 and the post-call pipeline never runs; see `docs/CREDENTIALS.md` § two URLs. BYO keys for Deepgram/ElevenLabs/LLM under Provider Keys. |
| 5 | `DEEPGRAM_API_KEY` | https://console.deepgram.com/ → project → API Keys | Member role. |
| 6 | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | https://elevenlabs.io/app/settings/api-keys · https://elevenlabs.io/app/voice-library | Scope the key to TTS and put it in Vapi's Provider Keys. `ELEVENLABS_VOICE_ID` is different: our code reads it and `vapi.syncAssistant` writes it onto the assistant. Pick a voice whose natural read is warm — tuning lifts a voice, it does not rewrite its character. The model and the stability/style/speed settings are **not** picked here; they are checked in at `packages/adapters/src/vapi/voice.ts`. |
| 7 | `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` | https://console.anthropic.com/settings/keys (or https://platform.openai.com/api-keys) | $5 prepay; mini tier. |
| 8 | `RESEND_API_KEY`, `MAIL_FROM` | https://resend.com/api-keys · https://resend.com/domains | Add domain `mail.transparentmaintenance.com`; paste DKIM/SPF at your DNS host; root `_dmarc` `p=reject`. Key scoped `sending_access` to that domain. |
| 9 | `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_CERT_PEM`, `MS_BOOKING_MAILBOX` | https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade → New registration `tm-voice-agent` → API permissions → Graph → Application → `Calendars.ReadWrite` → Grant admin consent; Certificates → upload | Create shared mailbox `booking@transparentmaintenance.com` at https://admin.exchange.microsoft.com/#/mailboxes; scope with `New-ManagementRoleAssignment` (RBAC for Applications) to that mailbox only. |
| 10 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | https://dash.cloudflare.com/?to=/:account/r2/overview → enable R2 → bucket `tm-call-recordings` → Manage R2 API Tokens (Object Read & Write, that bucket only) | Card at checkout; free tier. |
| 11 | `DNC_API_KEY` | https://www.donotcalldnc.com/ → buy $100 block → API key | |

After each paste, redeploy api and check `/health`: that vendor flips from `mode:"mock"` to `mode:"real"` with `ok:true`. Keys are only *required* once `DIAL_MODE` leaves `dry_run`; the config loader lists any missing ones by name.

## 5. Key rotation

Procedure and per-vendor rotation URLs: **`docs/CREDENTIALS.md` § Rotation**. Annual for every vendor key; quarterly for `INTERNAL_API_TOKEN`; Graph certificate at 24 months (set a calendar reminder — expiry is the classic 2am outage). Rotate = new value in 1Password → Railway variable on api *and* worker → redeploy → confirm `/health`. Note that `/health` cannot validate a credential while `DIAL_MODE=dry_run`: every adapter reports `mock` whatever its keys hold.

## 6. Go-live flip (nothing in code changes)

1. Telnyx Verified; DIDs registered; DoNotCallDNC funded **or `DNC_SCRUB=off` recorded as a counsel-reviewed decision** (see `docs/COMPLIANCE.md` § DNC scrub flag); counsel sign-off.
2. Cards on Vapi, Deepgram, Railway Hobby, Resend Pro, ElevenLabs Starter; LLM auto-reload at $50.
3. Rotate every trial-era key once.
4. `DIAL_MODE=verified_only`, `DIAL_ALLOWLIST=<your own numbers>` → place test calls (Phase 5).
   Only the dial-path keys are required to leave `dry_run`: `TELNYX_API_KEY`,
   `TELNYX_CONNECTION_ID`, `TELNYX_PUBLIC_KEY`, `VAPI_PRIVATE_KEY`, `VAPI_WEBHOOK_SECRET`,
   `VAPI_ASSISTANT_ID`, `DNC_API_KEY` (dropped from the set when `DNC_SCRUB=off`). Every other vendor stays mocked and is listed in a boot
   warning plus `/health`. Deepgram, the ElevenLabs API key and the LLM are configured inside Vapi's
   own Provider Keys, not here; `ELEVENLABS_VOICE_ID` is the exception and is read by
   `vapi.syncAssistant`. Prerequisites in the database before a campaign can run:
   a `SCRIPT_VERSION` row (`campaign.script_version_id` is NOT NULL), a `DID` row for the number
   you bought, and a `campaign` with `apollo_saved_search_id` set and `status='active'` so
   `apollo.syncCampaign` can fill the queue.
5. `DIAL_MODE=live`, `COMPLIANCE_TARGET_SURFACE=landline_only`, first campaign 10 dials/day on one DID, every booking human-reviewed (Phase 6). Record measured cost per dial here.
6. `consented_mobile` only after Phase 7 consent capture ships.

## 6b. Discord meeting capture (blocked: needs your accounts)

Four things to paste, in this order. Nothing here can be done without your credentials, and none of
it touches the dial path — if you skip this section entirely, the dialer is unaffected.

### 1. The Discord bot

<https://discord.com/developers/applications> → **New Application** → Bot.

- **Reset Token**, copy it once. That is `DISCORD_BOT_TOKEN`.
- Privileged Gateway Intents: leave **all three OFF**. The bot needs `Guilds` and
  `GuildVoiceStates`, neither of which is privileged. If you enable Message Content it will work
  just as well, which is exactly why it is worth not enabling.
- OAuth2 → URL Generator → scope `bot`, permissions **View Channel**, **Connect**, **Send
  Messages** — nothing else. Invite it to the server.
- Then remove those permissions everywhere except the channels you want recorded: Server Settings →
  the channel → Permissions. Channel-level Connect plus `WATCH_CHANNEL_IDS` is the whole recording
  boundary, and the code enforces the second half of it.
- Channel ids: Discord → User Settings → Advanced → Developer Mode on, then right-click a voice
  channel → Copy Channel ID. Comma-separate them into `WATCH_CHANNEL_IDS`.

**Pin a message in each watched channel** saying the channel is recorded. `docs/COMPLIANCE.md` §
Discord explains why the in-channel notice alone is not the whole story.

### 2. TM-OS: one-time DDL, then the key

`ops.tasks` lives in the Supabase project `uzvbzusomftegypxudbj` ("TM1") — the **same** project as
tm-voice's own `agents` schema, reached a different way: `ops` over PostgREST, `agents` over Drizzle.
Rule 4 still forbids reaching `ops` through Drizzle, so the adapter stays the only path.

> Corrected 2026-09-17. This section previously named `afazwqebmluuyoowjxoo`, which is not a project
> on this account. The error was latent — the adapter stays in mock mode until `TMOS_SERVICE_KEY` is
> set — so nothing had failed yet, and would have failed on the first real write.

Run this once in that project's SQL editor:

```sql
ALTER TABLE ops.tasks ADD COLUMN IF NOT EXISTS external_key text;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_key_uq ON ops.tasks (external_key);
```

Why a new column rather than a unique constraint on `source`, as originally specified: `source` is
already a low-cardinality **label**, not a per-row identifier — as of 2026-09-17 the table holds 54
rows with `source='manual'`, 34 `'process'`, 12 `'claude'` and 4 `'discord'`. A UNIQUE constraint on
it cannot be created without deleting data. `external_key` carries `vc:<session_id>:<n>` and `source`
stays a label.

The `source` vocabulary, as it actually is (not prefixed — no row uses a `vc:`-style prefix):

| `source` | Means |
|---|---|
| `manual` | A person typed it into the board |
| `process` | Generated by a recurring process; `process` names which |
| `claude` | Filed by Claude outside a meeting |
| `discord` | Captured from a Discord **text** message; `discord_message_url` points at it |
| `vc` | **New.** Captured from a Discord **voice** meeting; `external_key` is `vc:<session_id>:<n>` |

Then Supabase → that project → Settings → API → **service_role** key → `TMOS_SERVICE_KEY`.
`TMOS_SUPABASE_URL` is `https://uzvbzusomftegypxudbj.supabase.co`. The service role bypasses RLS, so
this key writes to every table in the project — **including the `agents` schema tm-voice owns** —
so keep it in 1Password and set it on the **worker only**. Capture never needs it.

Also worth checking while you are there: `POST /api/tasks` on the board answered an unauthenticated
request during this work. If that endpoint is genuinely open on the public internet, anyone can file
cards on the board. That is independent of this pipeline, which writes over PostgREST, but it is
worth knowing.

### 3. The batch STT key — deliberately not set

Leave `STT_BATCH_PROVIDER` and `STT_BATCH_API_KEY` **empty**. No provider has been chosen, the
adapter is mock in every mode, and setting them changes nothing except what `/health` prints. See
`docs/ARCHITECTURE.md` § 2 for why picking one now would contaminate the Phase 6.5 trigger audit.

`LLM_API_KEY` **is** needed on the worker now, for the first time — until this pipeline, the
Anthropic key was only ever pasted into Vapi's Provider Keys and no code here read it.

### 4. Fly.io

Capture cannot run on Railway: Discord voice media is Opus over UDP and Railway does not carry it.

```bash
fly auth login
fly apps create tm-voice-capture            # org: Kaminski (personal)
cd apps/capture
fly secrets set \
  DISCORD_BOT_TOKEN=... \
  WATCH_CHANNEL_IDS=123,456 \
  DATABASE_URL=... \
  REDIS_URL=... \
  INTERNAL_API_TOKEN=... \
  R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=tm-call-recordings
fly deploy --config fly.toml --dockerfile Dockerfile
fly logs                                     # expect "capture up" with the watched channel ids
curl https://tm-voice-capture.fly.dev/health # {"ok":true,"watched":2,...}
```

`DATABASE_URL` and `REDIS_URL` are the same values the Railway worker uses — capture writes the
meeting rows and enqueues onto the same Redis. `fly.toml` intentionally has **no UDP service block**:
a Fly service exposes an *inbound* port and needs a dedicated IPv4, while Discord voice is
outbound-initiated, so plain egress is all it needs.

### 5. Prove it end to end (the one check nobody could run before you)

Sit in a watched voice channel with a second person for two minutes and say one concrete thing —
"add a field for gate code" — then both leave.

| Expect | Where |
|---|---|
| The recording notice, posted the moment the bot joins | the channel |
| One object per speaker under `meetings/<guild>/<channel>/<ts>/` | R2 |
| `meeting` + `speaker_track` + `recording` rows, and a `consent_event(grant, channel='discord')` | Postgres |
| One `meeting.postcall` job, then one `meeting.extract` | `pnpm replay meeting <job_id>` to retry either |
| A card owned by Claude, role Task Intake, status inbox, notes carrying the speaker, timestamp and your verbatim line | TM-OS |
| One summary line: task count, duration, board link | the channel |

**If no audio arrives and the logs show a decryption failure, stop.** That is Discord's DAVE
end-to-end encryption, mandatory on all voice channels since 2026-03-02. `@discordjs/voice` 0.19.2
is pinned here precisely because it carries the fix (discord.js#11449, merged 2026-03-13), verified
in the published package but never on a live call. Do not work around it by disabling DAVE handling —
report it.

## 7. Cost-per-dial assumptions still unverified (from the assessment; measure in Phase 6)

| Input | Assumed | How to verify |
|---|---|---|
| Connect rate | 10% | `call.disposition` distribution after 500 dials |
| Connected conversation length | 2.5 min | mean `call.duration_sec` where disposition ∉ {voicemail, no_answer} |
| Voicemail drop rate / length | 60% / 0.2 min | same table |
| Vapi platform | $0.050/min | first invoice |
| ElevenLabs Flash | $0.035/min | first invoice; Aura-2/Cartesia fallback at $0.025 |
| Deepgram Nova-3 | $0.005/min | first invoice |
| LLM mini tier | $0.003–0.005/min | token usage × published price |
| Telnyx outbound | $0.005/min | first invoice |
| HCP rate limits | undocumented; throttle 2–5 rps | observe 429s in adapter logs |
| Fixed | $125/mo (Railway $20, Telnyx channels $50, DIDs $10, Resend $20, caller-ID reg $25) | invoices |

Blended assumption $0.095/min → $0.063/dial at 5,000 dials/mo; $1/call line at ~2,000 dials/mo. `call.cost_usd` is populated in Phase 5 from vendor usage so this table can be replaced with measurements.

## 7b. Changing how Joe behaves on a call

The opening line, the voice, the system prompt and the call-handling settings all live in this repo
and are pushed to Vapi by the `vapi.syncAssistant` job (`docs/ARCHITECTURE.md` § 9.1). Editing them
in the Vapi dashboard does not work: the sync reverts the edit within a day and logs the revert.

| To change | Edit | Takes effect |
|---|---|---|
| What Joe says first | a **new** `script_version` row, then mark it active | next sync |
| What Joe may say about the company | the **Licences** tab in TM-OS — licence numbers, crews, trades, routing contacts. Tick **Voice agent** on a row to let him state it; untick to silence it. Not a code change. | next sync |
| How Joe sounds | `packages/adapters/src/vapi/voice.ts` | next sync |
| How Joe behaves — turn-taking, email read-back, what he is trying to achieve | `packages/adapters/src/vapi/conversation.ts` | next sync |
| Ambient noise, interruption handling, silence and call-length limits | `SPEECH_PLAN` in `conversation.ts` | next sync |
| Which LLM, which transcriber, which tools exist | Vapi dashboard — not owned here | immediately |

**The sync only writes for real outside `dry_run`.** In `DIAL_MODE=dry_run` the vapi adapter is a
mock, so `updateAssistant` records the PATCH it *would* have sent and the live assistant is not
touched. A behaviour fix merged while the system is in `dry_run` reaches a real call only once the
mode is `verified_only` or `live`.

The job runs every 24h and on worker boot, so a deploy is usually enough. To force it, restart the
worker. To see what it would do without waiting, the drift list is in the worker log line
`vapi assistant reconciled to the checked-in profile`.

**If a caller still reports background noise** after a sync has run with `backgroundSound: "off"`,
the remaining suspect is the ElevenLabs voice itself — a voice cloned from a recording with room
noise carries that noise into every render. That is a different fix: a new `ELEVENLABS_VOICE_ID`,
not a settings change. Check it by generating a sample in the ElevenLabs dashboard with no Vapi in
the path.

**If a caller reports long silences**, check in this order: (1) `silenceTimeoutSeconds` in
`SPEECH_PLAN` — Joe should break a silence before it reads as a dropped call; (2) the worker log for
`vapi called a tool with no route on this service`, which means the dashboard has a tool the api
does not implement and the catch-all is covering for it; (3) the model configured in the dashboard,
which the repo does not own.

## 7c. Working the review queue

`AUTO_BOOK` is settled `false`, so every booking the agent creates waits for a person. That person
uses `/review` on the console: pending bookings with approve and reject, and a **stop dialling**
button per campaign.

| Thing | Where | Note |
|---|---|---|
| Approve / reject a booking | `/review` | Approving queues three jobs — the Housecall Pro job, the calendar invite and the packet email. Each can still fail afterwards, and those failure states have no screen yet: check `calendar_invite.rsvp_status` and `email_send.status`. |
| Stop a campaign mid-flight | `/review` → Stop dialling | Stops the **next** call. A call already in progress finishes; nothing hangs up a live call on a prospect. |
| Resume | `/review` → Resume | Dialling picks up on the next `dial.tick`, within 60s. |

**The console has no authentication.** None — no session, no login, no middleware. So the reviewer
types their name and `booking.reviewed_by` records what they typed. That is good enough for two or
three people who trust each other and is not an audit trail; before this is used by anyone else,
the console needs real auth. It is the largest known gap in this system that is not a vendor
dependency.

## 8. Operations

- Dead letters: worker moves a job to queue `dead` after 5 failed attempts. `pnpm replay <queue> <job_id>` re-enqueues it.
- Schema change: edit `packages/db/src/schema.ts` → `pnpm db:generate` → `pnpm erd:write` → commit both. CI fails on drift.
- Adding a vendor: new folder in `packages/adapters/src/<vendor>` implementing `Adapter`; register in `createAdapters`; add its string to the `Vendor` union in `packages/shared/src/errors.ts`; add keys to `VENDOR_KEYS`, `infra/env.example` and `docs/CREDENTIALS.md`; update `docs/ARCHITECTURE.md`. Two test files hard-code the key list and the vendor count (`packages/adapters/test/helpers.ts`, `test/adapters.test.ts`) and will fail until updated — that is intentional.
- A meeting that never finished: `apps/capture` writes the `meeting` row on join, so a capture process killed mid-meeting leaves a row with `ended_at IS NULL` and `transcription_state='pending'`. That is the signal, and it is deliberate — the alternative is a recording with no evidence it happened.
- A stuck transcription: `speaker_track.transcription_state='failed'` names the track. Fix the cause and `pnpm replay meeting <job_id>`; tracks already `transcribed` are skipped, so a retry costs only the tracks that failed.
