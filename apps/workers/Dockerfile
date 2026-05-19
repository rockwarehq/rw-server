# Build for apps/workers inside the pnpm monorepo.
# Run from workspace root: docker build -f apps/workers/Dockerfile .

# ----------------------------
# Stage 1: Builder
# ----------------------------
FROM node:24.13.0-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY .npmrc ./
COPY packages/db/package.json ./packages/db/
COPY packages/runtime/package.json ./packages/runtime/
COPY apps/api/package.json ./apps/api/
COPY apps/workers/package.json ./apps/workers/

COPY packages/db/schema ./packages/db/schema/
COPY packages/db/prisma.config.ts ./packages/db/

RUN pnpm install --frozen-lockfile

RUN pnpm db:generate

COPY packages/ ./packages/
COPY apps/api ./apps/api/
COPY apps/workers ./apps/workers/

# Build apps/workers (and its transitive deps — including apps/api since the
# rollups + processor-consumer modes import from it)
RUN pnpm --filter @rw/workers... build

# ----------------------------
# Stage 2: Production image
# ----------------------------
FROM node:24.13.0-alpine
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

ENV NODE_ENV=production

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY .npmrc ./
COPY packages/db/package.json ./packages/db/
COPY packages/runtime/package.json ./packages/runtime/
COPY apps/api/package.json ./apps/api/
COPY apps/workers/package.json ./apps/workers/
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /repo/packages/db/dist ./packages/db/dist
COPY --from=builder /repo/packages/db/src/generated ./packages/db/src/generated
COPY --from=builder /repo/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/workers/dist ./apps/workers/dist

COPY --from=builder /repo/packages/db/schema ./packages/db/schema
COPY --from=builder /repo/packages/db/migrations ./packages/db/migrations
COPY --from=builder /repo/packages/db/prisma.config.ts ./packages/db/

EXPOSE 9465

WORKDIR /repo/apps/workers
# fly.toml overrides CMD per process group via --worker flag.
CMD ["node", "dist/main.js", "--worker", "rollups"]
