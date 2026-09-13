# Runbook — TM Voice

What Michael pastes, where, and how to prove it landed. Owner identity for every vendor account: `michael@transparentmaintenance.com`. Secrets go in 1Password vault **"TM Voice"** and Railway variables — never in the repo. The variable manifest is `infra/env.example` (named without the leading dot because local hooks deny `.env.*` paths; copy it to `.env` for local dev).

Status as of 2026-09-08: Phases 0–2 built and green locally with every vendor mocked. Nothing has been deployed and no account has been created by Claude Code.

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
| 4 | `VAPI_PRIVATE_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_ASSISTANT_ID` | https://dashboard.vapi.ai/org/api-keys · **you invent the secret** · https://dashboard.vapi.ai/assistants | `VAPI_WEBHOOK_SECRET` is not on any page: generate a string, put it in a Vapi *Bearer Token* Custom Credential selected under Assistant → Advanced → Webhook Server → Authorization, and paste the same string here. Vapi sends it as `X-Vapi-Secret`. The assistant's `firstMessage` must equal `SCRIPT_VERSION.disclosure_line` — the seeded *Riley* demo assistant does not. Server URL = `https://<api-domain>/tools`. BYO keys for Deepgram/ElevenLabs/LLM under Provider Keys. |
| 5 | `DEEPGRAM_API_KEY` | https://console.deepgram.com/ → project → API Keys | Member role. |
| 6 | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | https://elevenlabs.io/app/settings/api-keys · https://elevenlabs.io/app/voice-library | Scope to TTS. Flash model. |
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
   warning plus `/health`. Deepgram, ElevenLabs and the LLM are configured inside Vapi's own
   Provider Keys, not here. Prerequisites in the database before a campaign can run:
   a `SCRIPT_VERSION` row (`campaign.script_version_id` is NOT NULL), a `DID` row for the number
   you bought, and a `campaign` with `apollo_saved_search_id` set and `status='active'` so
   `apollo.syncCampaign` can fill the queue.
5. `DIAL_MODE=live`, `COMPLIANCE_TARGET_SURFACE=landline_only`, first campaign 10 dials/day on one DID, every booking human-reviewed (Phase 6). Record measured cost per dial here.
6. `consented_mobile` only after Phase 7 consent capture ships.

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

## 8. Operations

- Dead letters: worker moves a job to queue `dead` after 5 failed attempts. `pnpm replay <queue> <job_id>` re-enqueues it.
- Schema change: edit `packages/db/src/schema.ts` → `pnpm db:generate` → `pnpm erd:write` → commit both. CI fails on drift.
- Adding a vendor: new folder in `packages/adapters/src/<vendor>` implementing `Adapter`; register in `createAdapters`; update `docs/ARCHITECTURE.md`.
