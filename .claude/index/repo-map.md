# Repo map — TransparentOutbound   (none, 2026-09-09T00:21:59Z)

Read this once. Then `grep` `.claude/index/symbols.tsv` for exact symbols —
`name<TAB>kind<TAB>path:line`, 140 entries. Do not read symbols.tsv whole.

## Layers

| Layer | Where | Files |
|---|---|---|
| Front-end |  | 0 |
| Back-end |  | 2 |
| Middleware |  | 0 |
| Infrastructure |  | 2 |

## Entry points
- `./packages/db/src/index.ts`
- `./packages/adapters/src/r2/index.ts`
- `./packages/adapters/src/resend/index.ts`
- `./packages/adapters/src/vapi/index.ts`
- `./packages/adapters/src/index.ts`
- `./packages/adapters/src/hcp/index.ts`
- `./packages/adapters/src/apollo/index.ts`
- `./packages/adapters/src/graph/index.ts`
- `./packages/adapters/src/dnc/index.ts`
- `./packages/adapters/src/telnyx/index.ts`
- `./packages/compliance/src/index.ts`
- `./packages/shared/src/index.ts`

## Task runner
- npm run build
- npm run ci
- npm run db:generate
- npm run db:migrate
- npm run db:seed
- npm run dev
- npm run erd:check
- npm run lint
- npm run replay
- npm run test
- npm run typecheck
