# syntax=docker/dockerfile:1
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
RUN pnpm install --frozen-lockfile --filter @tm/worker... --config.confirmModulesPurge=false
ENV NODE_ENV=production
WORKDIR /repo/apps/worker
CMD ["pnpm", "start"]
