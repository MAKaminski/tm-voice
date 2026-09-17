# Credentials — where each variable comes from

Canonical location for every credential the system reads. If a URL or portal path is wrong here, fix
it here first: `docs/RUNBOOK.md` §4 links to this file rather than repeating the list.

Every variable named below is set as a Railway variable on **both** `api` and `worker`, except the
four marked **→ Vapi**, which are pasted into Vapi's own Provider Keys and are never read by our
code. `packages/shared/src/config.ts` is the authoritative list of names; `VENDOR_KEYS` there and the
table here must agree.

## Read this first: three kinds of credential

Two of these are not values you can go and look up, which is the usual reason a hunt fails.

| Kind | What to do | Which variables |
|---|---|---|
| **Read from a portal** | Navigate, reveal, copy. | Most of them. |
| **You invent it** | Generate a random string, paste it into *both* sides. There is no page showing it, and no page will ever show it back to you. | `INTERNAL_API_TOKEN`, `VAPI_WEBHOOK_SECRET` |
| **The id of a thing you create** | Create the object first; the id appears on the object afterwards. | `TELNYX_CONNECTION_ID`, `VAPI_ASSISTANT_ID`, `R2_BUCKET`, `MS_BOOKING_MAILBOX` |

### Portal deep links need an existing session

`portal.telnyx.com/#/...` and `dashboard.vapi.ai/...` are single-page apps. The part after `#` never
reaches the server, so opening one of these links while logged out bounces you to a login page and
**silently drops the destination** — you land on a dashboard home or a "Page Not Found" and the link
looks broken when it isn't. Log in first, then paste the URL.

## Telnyx

Portal: <https://portal.telnyx.com/>

| Variable | Exact path | Notes |
|---|---|---|
| `TELNYX_API_KEY` | Account Settings → **API Keys** → create → reveal once<br><https://portal.telnyx.com/#/app/api-keys> | Shown once at creation. Rotating means creating a new key and deleting the old one. |
| `TELNYX_CONNECTION_ID` | `POST https://api.telnyx.com/v2/call_control_applications` with `application_name` and `webhook_event_url` → `data.id`<br>Or the portal: **Voice → Programmable Voice → Call Control / TeXML Applications** → Create → open it → **Application ID** (<https://portal.telnyx.com/#/app/next/call-control/applications>) | **This is not a SIP Connection.** The API calls the object a *call control application* and the field `connection_id`; the portal calls it a *Voice API Application* and the value *Application ID*. Same number, three names — which is why searching the portal for "connection id" finds nothing. `#/app/connections` is the SIP Connections page and is the wrong place. |
| `TELNYX_PUBLIC_KEY` | `curl -H "Authorization: Bearer $TELNYX_API_KEY" https://api.telnyx.com/v2/public_key` → `data.public`<br>Or the portal: Account Settings → **Keys & Credentials** → **Public Key** sub-tab (<https://portal.telnyx.com/#/app/account/public-key>) | Ed25519 webhook signing key, account-wide. **`GET /v2/public_key` works even though the published OpenAPI document does not list it** — searching that document for a public-key endpoint finds only WireGuard and is misleading. Rotate: <https://support.telnyx.com/en/articles/8370064-update-webhook-sign-key-guide> |

When you create the Voice API Application, its **Webhook URL** field is required. Point it at
`https://<api-domain>/webhooks/telnyx` and set `call_cost_in_webhooks` (portal: **Enable Call Cost**)
— `docs/RUNBOOK.md` §7 wants a measured cost per dial and that figure cannot be backfilled. Use
**API v2** — the `telnyx` adapter verifies v2's
Ed25519 `telnyx-signature-ed25519` / `telnyx-timestamp` headers. Note that route is **not built yet**
(`apps/api/src/routes/webhooks.ts` serves only `/hcp`), so `telnyxWebhookOk()` currently has no
caller. Nothing is dialed in `dry_run`, so an unimplemented URL costs nothing today, but the route
has to exist before leaving it.

All three are required together outside `dry_run`. The Telnyx mock resolves most numbers to
`landline`, the one value `landline_only` accepts, so a partial Telnyx config would fail *open* and
dial mobiles. `DIAL_PATH_VENDOR_KEYS` enforces the set.

Also needed, not a variable: KYC to Verified (account icon → Account Settings → **Account Level**),
a purchased DID (<https://portal.telnyx.com/#/app/numbers/search-numbers>), and caller-ID
registration (<https://www.freecallerregistry.com/fcr/>).

## Vapi

Dashboard: <https://dashboard.vapi.ai/>

| Variable | Exact path | Notes |
|---|---|---|
| `VAPI_PRIVATE_KEY` | **Org Settings → API Keys** → Private API Keys → eye icon<br><https://dashboard.vapi.ai/org/api-keys> | `dashboard.vapi.ai/keys` is a stale path. Private key only — the public key is for browser clients and will not authenticate a server call. |
| `VAPI_WEBHOOK_SECRET` | **Nowhere. You invent this value.** | Vapi replaced the inline `server.secret` field with credentials. Create a **Custom Credential** of type *Bearer Token* whose token is a random string you generate, then Dashboard → **Assistants** → your assistant → **Advanced** → **Webhook Server** → Authorization → select that credential. Vapi then sends your string in the `X-Vapi-Secret` header, which `apps/api/src/middleware.ts` compares against this variable. Confirmation that it is write-only: `GET /assistant/{id}` returns the read-only boolean `isServerUrlSecretSet`, never the secret. |
| `VAPI_ASSISTANT_ID` | Dashboard → **Assistants** → the assistant → copy its id<br><https://dashboard.vapi.ai/assistants> | Must be an assistant whose `firstMessage` is **exactly** `SCRIPT_VERSION.disclosure_line` (CLAUDE.md rule 10). Vapi seeds new orgs with a demo assistant named *Riley* whose `firstMessage` is "Thank you for calling Wellness Partners…" — an inbound greeting for another company. Using it would say the wrong company name and break rule 10. Since the voice sync landed, `vapi.syncAssistant` overwrites `firstMessage` with the active `SCRIPT_VERSION.disclosure_line` within a day, so pointing this at the wrong assistant now rewrites that assistant rather than dialling with the wrong greeting. Point it at the right one. |
| `DEEPGRAM_API_KEY` **→ Vapi** | <https://console.deepgram.com/> → project → API Keys | Provider Keys inside Vapi. Not read by our code. |
| `ELEVENLABS_API_KEY` **→ Vapi** | <https://elevenlabs.io/app/settings/api-keys> | Provider Keys inside Vapi. Not read by our code. |
| `ELEVENLABS_VOICE_ID` | <https://elevenlabs.io/app/voice-library> | **Read by our code.** `vapi.syncAssistant` puts it in the assistant's voice block, so this is which voice the agent *is*. How it *sounds* is not here: that tuning is checked in at `packages/adapters/src/vapi/voice.ts` and reviewed as a diff (`docs/ARCHITECTURE.md` §9.1). Changing this variable swaps the voice on the next sync; unset it and the sync stops and logs rather than dialling voiceless. |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` **→ Vapi** | <https://console.anthropic.com/settings/keys> | Provider Keys inside Vapi for the dial path. Since the Discord capture pipeline landed these are **also read by our code** on the worker — see `LLM_API_KEY` in the next table. A blank value here crash-loops the api — see "blank is not unset" below. |

### Two URLs, and getting them the wrong way round silently kills the post-call pipeline

Vapi has two separate places a URL goes, and they are not interchangeable:

| Vapi setting | Value | What arrives there |
|---|---|---|
| **Assistant → Advanced → Webhook Server → Server URL** | `https://<api-domain>/webhooks/vapi` | `end-of-call-report`, and every other assistant-level server message |
| **Each function tool's own Server URL** | `https://<api-domain>/tools/<tool_name>` | that tool's calls, e.g. `/tools/capture_contact` |

**This document previously said the Server URL was `https://<api-domain>/tools`. That was wrong.**
Set that way, every end-of-call report POSTs to `/tools`, matches no tool route, and 404s — so
`postcall.process` never runs and **nothing records the disposition, transcript, cost, retry
schedule or opt-out for any call**. Nothing alerts, because from the api's side a 404 on an
unknown tool path is indistinguishable from a misconfigured tool.

If you have ever set the Server URL to `/tools`, **check it now**, and assume no call before the
correction was recorded. The `/tools` catch-all logs a named error
(`vapi end-of-call report arrived on /tools`) if it happens again.

Org-wide default lives at Dashboard → Settings → General Settings; the assistant-level value
overrides it.

## Everything else

| Variable | Exact path | Notes |
|---|---|---|
| `HCP_API_KEY` | <https://pro.housecallpro.com/pro/settings/api> | Verified working: `GET /company` returns 200 under **both** `Bearer` and `Token`; the client uses Bearer. Subscribing `job.scheduled`, `job.completed`, `customer.updated`, `pro.created` → `https://<api-domain>/webhooks/hcp` is optional: the route fails closed until a webhook signing secret is configured (none is yet — the header is reported second-hand as `x-housecallpro-signature`), and the 15-minute materializer keeps availability fresh without it. |
| `APOLLO_API_KEY` | <https://app.apollo.io/#/settings/integrations/api> | Must be a **master** key — `/accounts/search`, `/phone_calls` and `/contacts/search` all refuse a non-master key. Check with `GET /auth/health`. |
| `DNC_API_KEY` | <https://www.donotcalldnc.com/> → buy a lookup block → API key | **Not required while `DNC_SCRUB=off`** — the loader drops it from the dial-path keys and the gate makes no lookup (cached hits still block). Set `DNC_SCRUB=required` the day a block is bought. Federal determination only; state scrubbing is an open gap (`docs/COMPLIANCE.md`). |
| `RESEND_API_KEY`, `MAIL_FROM` | <https://resend.com/api-keys> · <https://resend.com/domains> | Domain `mail.transparentmaintenance.com`; key scoped `sending_access` to it. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_CERT_PEM` | <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade> → the app registration → Overview (tenant + client id) → Certificates & secrets → Certificates (upload) | `MS_CLIENT_CERT_PEM` is the **PEM text**, holding a `CERTIFICATE` block *and* a `PRIVATE KEY` block, because PS256 `private_key_jwt` signs with the key and sends `x5t#S256` of the cert. A certificate thumbprint or key id GUID is not a substitute and will fail at `parseCertPem()`. Expires at 24 months — set a reminder. |
| `MS_BOOKING_MAILBOX` | <https://admin.exchange.microsoft.com/#/mailboxes> | Shared mailbox `booking@transparentmaintenance.com`; scope the app to it alone with `New-ManagementRoleAssignment`. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | R2 → bucket → Manage R2 API Tokens (Object Read & Write, one bucket). Sign-up, if ever needed again, is the plain <https://dash.cloudflare.com/sign-up> — a `?to=` deep link there fails with "Invalid redirect_uri". | **Minted — values are in 1Password, not here.** `R2_ACCOUNT_ID` is the 32-hex label in the S3 endpoint host (`https://<account_id>.r2.cloudflarestorage.com/<bucket>`), so you never need to hunt the sidebar for it. The secret is shown once. A *Cloudflare API token* (`cfat_…`) is a different credential and is **not** used here: the `r2` adapter signs SigV4 with the access key pair, so a broad account token should not be minted or stored for this. See the two open items below before setting `R2_BUCKET`. |
| `DISCORD_BOT_TOKEN` | <https://discord.com/developers/applications> → your app → Bot → **Reset Token** | Shown once. **Leave all three Privileged Gateway Intents OFF** — the bot needs `Guilds` and `GuildVoiceStates`, neither of which is privileged, and enabling Message Content would grant a read surface it has no use for. Bot permissions are View Channel + Connect + Send Messages, scoped to the watched channels only. Set on `apps/capture` (Fly.io) and on the worker, which posts the summary line back. |
| `WATCH_CHANNEL_IDS` | Discord → User Settings → Advanced → Developer Mode on → right-click a voice channel → Copy Channel ID | Comma-separated. **This is the recording boundary**, together with channel-level Connect. Empty means record nothing, not record everything. Capture refuses to boot without it rather than running as a silent no-op. |
| `STT_BATCH_PROVIDER`, `STT_BATCH_API_KEY` | **Nowhere yet. Leave both empty.** | No batch STT vendor has been chosen. The adapter is mock in *every* mode including `live`, so setting these changes nothing but the `/health` detail string. `docs/ARCHITECTURE.md` § 2 has the reasoning; picking one is a decision, not a paste. |
| `TMOS_SUPABASE_URL`, `TMOS_SERVICE_KEY` | Supabase → project `afazwqebmluuyoowjxoo` → Settings → API → **service_role** | A **different project** from tm-voice's `DATABASE_URL`. service_role bypasses RLS and writes every table in that project, so set it on the **worker only** — capture never needs it. Requires the one-time `ops.tasks.external_key` DDL first (`docs/RUNBOOK.md` § 6b). |
| `TMOS_BOARD_URL` | The board's own URL | `https://tm-os-makaminski1337.vercel.app/#today`. Cosmetic: the link in the summary line posted back to the Discord channel. |
| `LLM_API_KEY` | <https://console.anthropic.com/settings/keys> | **Now read by our code**, unlike the row above — `meeting.extract` calls the Messages API directly. `LLM_MODEL` defaults to `claude-haiku-4-5-20251001`. `LLM_PROVIDER` must be `anthropic` or unset: `openai` is an allowed value in `infra/env.example` but only the Anthropic wire format is implemented, and the adapter refuses to construct rather than failing mid-meeting. |
| `INTERNAL_API_TOKEN` | **You invent this value.** `openssl rand -hex 20` | Console → api bearer. Minimum 16 chars (`config.ts`). Same value on api, worker and console. |
| `DATABASE_URL`, `REDIS_URL` | Railway → the service → Variables | Postgres is Supabase, not the Railway plugin. |

## Rotation

Annual for every vendor key, quarterly for `INTERNAL_API_TOKEN`, and the Graph certificate at 24
months. The procedure is the same in every case:

1. Mint the new value at the URL above.
2. Store it in 1Password vault **TM Voice** — never in this repo.
3. Set the Railway variable on **both** `api` and `worker` (or paste into Vapi for the four marked **→ Vapi**).
4. Redeploy and check `/health`: that vendor reads `mode:"real"` with `ok:true`.
5. Delete the old value at the vendor.

Two traps worth knowing before you rotate anything:

- **`/health` cannot validate a credential while `DIAL_MODE=dry_run`.** Every adapter reports
  `mock` regardless of its keys, so a rotation that broke something looks identical to one that
  worked. The first real check of any credential is the moment you leave `dry_run`.
- **Blank is not unset, to Railway.** A declared-but-empty Railway variable arrives as `""`.
  `LLM_PROVIDER` and `LLM_MODEL` were once set to empty strings and crash-looped the api against
  `z.string().min(1)`. `dropBlanks()` in `config.ts` now treats whitespace-only as absent, so a
  blank falls back to the mock instead of killing boot — but it also means a variable you *think*
  you set may be doing nothing. Delete a variable you mean to unset rather than blanking it.

## Two Telnyx things that are not credentials

Both are required before a dial and neither is an environment variable, so nothing in the config
loader will tell you they are missing:

- **A DID.** `GET /v2/phone_numbers` returning an empty list means there is no number to call from,
  and the dial fails at the vendor rather than at the gate. Buy one at
  <https://portal.telnyx.com/#/app/numbers/search-numbers>, then register it at
  <https://www.freecallerregistry.com/fcr/>. A `did` row also has to exist in the database.
- **Account balance and KYC.** `GET /v2/balance` shows what is actually funded. KYC to Verified is
  account icon → Account Settings → **Account Level**.

## Open items on the storage side

Two things about R2 that are decisions, not lookups, and both get more expensive the longer they wait.

- **The Cloudflare account belongs to Modular Equity, not Transparent Maintenance.** Call recordings
  are a Transparent Maintenance record with a five-year retention requirement, so they should not sit
  under another entity's account. Migrating later means re-minting the R2 key pair, updating
  `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in Railway on **both** api and worker,
  and moving whatever has accumulated. Do it before recordings start, not after.
- **`R2_BUCKET` should be its own bucket.** The bucket minted so far (`tm-os-1`) belongs to TM OS.
  `docs/ARCHITECTURE.md` assumes a dedicated recordings bucket, the retention sweeper deletes on a
  five-year clock, and the R2 API token should be scoped to one bucket — all three argue for a
  separate `tm-call-recordings` rather than sharing an application bucket.
