# syntax=docker/dockerfile:1
FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/console ./apps/console
RUN pnpm install --frozen-lockfile --filter @tm/console...
WORKDIR /repo/apps/console
RUN pnpm build

FROM node:22-slim AS run
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/console/.next/standalone ./
COPY --from=build /repo/apps/console/.next/static ./apps/console/.next/static
EXPOSE 3000
CMD ["node", "apps/console/server.js"]
