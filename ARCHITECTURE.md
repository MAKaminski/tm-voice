# TM Voice — Architecture

Full document: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Schema: [docs/ERD.md](docs/ERD.md) (generated block checked in CI via `pnpm erd:check`). Compliance: [docs/COMPLIANCE.md](docs/COMPLIANCE.md). Setup and go-live: [docs/RUNBOOK.md](docs/RUNBOOK.md).

| Layer | Lives in |
|---|---|
| Front-end | `apps/console` |
| Middleware | `apps/api`, `apps/worker`, `packages/adapters`, `packages/compliance`, `packages/shared` |
| Back-end | `packages/db`, Redis, R2 |
| Infrastructure | `infra/`, `apps/*/Dockerfile`, `.github/workflows/ci.yml` |
