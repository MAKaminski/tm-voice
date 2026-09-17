# syntax=docker/dockerfile:1
FROM node:22-slim AS base
# ffmpeg re-encodes each speaker track to 16 kbps before upload. It is the only system dependency:
# nothing here decodes Opus in-process, so there is no native node binding to build.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
RUN pnpm install --frozen-lockfile --filter @tm/capture... --config.confirmModulesPurge=false
ENV NODE_ENV=production
WORKDIR /repo/apps/capture
CMD ["pnpm", "start"]
