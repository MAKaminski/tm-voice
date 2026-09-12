# TM Voice Agent

Autonomous outbound voice agent for Transparent Maintenance. Read docs/ARCHITECTURE.md and docs/ERD.md before touching anything.

## Layers
- Front-end: apps/console (Next.js)
- Middleware: apps/api (Hono), apps/worker (BullMQ), packages/adapters, packages/compliance
- Back-end: packages/db (Drizzle/Postgres), Redis
- Infrastructure: Railway (CPU only), Telnyx, Vapi, R2

## Rules
1. Vendor SDKs are imported ONLY inside packages/adapters/<vendor>. Nowhere else.
2. Every external write is a BullMQ job with the standard envelope and an idempotency key.
3. No code path reaches Telnyx or Vapi without a CALL_TASK.gate_result = 'pass' in the same transaction.
4. CONSENT_EVENT is append-only. SUPPRESSION is unique on phone_e164. Never key suppression on contact.
5. DIAL_MODE (dry_run | verified_only | live) is enforced in the telnyx and vapi adapters, not the UI.
6. Secrets come from env only. Config loader is zod-validated and fails fast. Where each variable comes from — exact portal path, which values you invent rather than look up, how to rotate — is `docs/CREDENTIALS.md`; keep it correct there and link to it rather than repeating URLs.
7. A PR that changes the schema updates docs/ERD.md. A PR that adds a vendor updates docs/ARCHITECTURE.md. CI enforces the ERD check.
8. Reuse the adapter interface and job envelope. Do not invent a second pattern for either.
9. Never dial a wireless number unless COMPLIANCE_TARGET_SURFACE=consented_mobile AND a grant CONSENT_EVENT exists. Never enroll voiceprints.
10. Opening line is fixed in SCRIPT_VERSION.disclosure_line and must be the first utterance. Do not paraphrase it.

## Commands
pnpm dev · pnpm run ci · pnpm db:migrate · pnpm db:seed · pnpm replay <queue> <job_id>
