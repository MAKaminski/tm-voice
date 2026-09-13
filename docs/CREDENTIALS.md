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
| `TELNYX_CONNECTION_ID` | **Voice → Programmable Voice → Call Control / TeXML Applications** → Create → open it → **Application ID**<br><https://portal.telnyx.com/#/app/next/call-control/applications> | **This is not a SIP Connection.** The API calls the object a *call control application* and the field `connection_id`; the portal calls it a *Voice API Application* and the value *Application ID*. Same number, three names — which is why searching the portal for "connection id" finds nothing. `#/app/connections` is the SIP Connections page and is the wrong place. |
| `TELNYX_PUBLIC_KEY` | Account Settings → **Keys & Credentials** → **Public Key** sub-tab<br><https://portal.telnyx.com/#/app/account/public-key> | Ed25519 webhook signing key, account-wide. Not exposed by the API — the Telnyx OpenAPI document has no public-key endpoint, so the portal is the only source. Rotate: <https://support.telnyx.com/en/articles/8370064-update-webhook-sign-key-guide> |

When you create the Voice API Application, its **Webhook URL** field is required. Point it at
`https://<api-domain>/webhooks/telnyx` and use **API v2** — the `telnyx` adapter verifies v2's
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
| `VAPI_ASSISTANT_ID` | Dashboard → **Assistants** → the assistant → copy its id<br><https://dashboard.vapi.ai/assistants> | Must be an assistant whose `firstMessage` is **exactly** `SCRIPT_VERSION.disclosure_line` (CLAUDE.md rule 10). Vapi seeds new orgs with a demo assistant named *Riley* whose `firstMessage` is "Thank you for calling Wellness Partners…" — an inbound greeting for another company. Using it would say the wrong company name and break rule 10. |
| `DEEPGRAM_API_KEY` **→ Vapi** | <https://console.deepgram.com/> → project → API Keys | Provider Keys inside Vapi. Not read by our code. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` **→ Vapi** | <https://elevenlabs.io/app/settings/api-keys> · <https://elevenlabs.io/app/voice-library> | Provider Keys inside Vapi. Not read by our code. |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` **→ Vapi** | <https://console.anthropic.com/settings/keys> | Provider Keys inside Vapi. A blank value here crash-loops the api — see "blank is not unset" below. |

Server URL is `https://<api-domain>/tools`. Org-wide default lives at Dashboard → Settings →
General Settings; the assistant-level value overrides it.

## Everything else

| Variable | Exact path | Notes |
|---|---|---|
| `HCP_API_KEY` | <https://pro.housecallpro.com/pro/settings/api> | Verified working: `GET /company` returns 200 under **both** `Bearer` and `Token`. Also subscribe `job.scheduled`, `job.completed`, `customer.updated`, `pro.created` → `https://<api-domain>/webhooks/hcp`. |
| `APOLLO_API_KEY` | <https://app.apollo.io/#/settings/integrations/api> | Must be a **master** key — `/accounts/search`, `/phone_calls` and `/contacts/search` all refuse a non-master key. Check with `GET /auth/health`. |
| `DNC_API_KEY` | <https://www.donotcalldnc.com/> → buy a lookup block → API key | Federal determination only; state scrubbing is an open gap (`docs/COMPLIANCE.md`). |
| `RESEND_API_KEY`, `MAIL_FROM` | <https://resend.com/api-keys> · <https://resend.com/domains> | Domain `mail.transparentmaintenance.com`; key scoped `sending_access` to it. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_CERT_PEM` | <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade> → the app registration → Overview (tenant + client id) → Certificates & secrets → Certificates (upload) | `MS_CLIENT_CERT_PEM` is the **PEM text**, holding a `CERTIFICATE` block *and* a `PRIVATE KEY` block, because PS256 `private_key_jwt` signs with the key and sends `x5t#S256` of the cert. A certificate thumbprint or key id GUID is not a substitute and will fail at `parseCertPem()`. Expires at 24 months — set a reminder. |
| `MS_BOOKING_MAILBOX` | <https://admin.exchange.microsoft.com/#/mailboxes> | Shared mailbox `booking@transparentmaintenance.com`; scope the app to it alone with `New-ManagementRoleAssignment`. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | R2 → bucket → Manage R2 API Tokens (Object Read & Write, one bucket). Sign-up, if ever needed again, is the plain <https://dash.cloudflare.com/sign-up> — a `?to=` deep link there fails with "Invalid redirect_uri". | **Minted — values are in 1Password, not here.** `R2_ACCOUNT_ID` is the 32-hex label in the S3 endpoint host (`https://<account_id>.r2.cloudflarestorage.com/<bucket>`), so you never need to hunt the sidebar for it. The secret is shown once. A *Cloudflare API token* (`cfat_…`) is a different credential and is **not** used here: the `r2` adapter signs SigV4 with the access key pair, so a broad account token should not be minted or stored for this. See the two open items below before setting `R2_BUCKET`. |
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
