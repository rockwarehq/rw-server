# Build for apps/api inside the pnpm monorepo.
# Run from workspace root: docker build -f apps/api/Dockerfile .

# ----------------------------
# Stage 1: Builder
# ----------------------------
FROM node:24.13.0-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Copy workspace manifests + lockfile + tsconfig
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY .npmrc ./

# Copy package + app manifests so pnpm can build a dep graph
COPY packages/db/package.json ./packages/db/
COPY packages/runtime/package.json ./packages/runtime/
COPY apps/api/package.json ./apps/api/
COPY apps/workers/package.json ./apps/workers/

# Copy the prisma schema first so we can generate the client
COPY packages/db/schema ./packages/db/schema/
COPY packages/db/prisma.config.ts ./packages/db/

RUN pnpm install --frozen-lockfile

# Generate Prisma client (writes to packages/db/src/generated)
RUN pnpm db:generate

# Now copy the rest of the source
COPY packages/ ./packages/
COPY apps/api ./apps/api/

# Build only the api app (and its dependencies via project refs)
RUN pnpm --filter @rw/api... build

# ----------------------------
# Stage 2: Production image
# ----------------------------
FROM node:24.13.0-alpine
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

ENV NODE_ENV=production

# Production deps install
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY .npmrc ./
COPY packages/db/package.json ./packages/db/
COPY packages/runtime/package.json ./packages/runtime/
COPY apps/api/package.json ./apps/api/
COPY apps/workers/package.json ./apps/workers/
RUN pnpm install --prod --frozen-lockfile

# Copy build artifacts and the generated prisma client
COPY --from=builder /repo/packages/db/dist ./packages/db/dist
COPY --from=builder /repo/packages/db/src/generated ./packages/db/src/generated
COPY --from=builder /repo/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder /repo/apps/api/dist ./apps/api/dist

# Copy schema + migrations so the running container can apply migrations if it wants to
COPY --from=builder /repo/packages/db/schema ./packages/db/schema
COPY --from=builder /repo/packages/db/migrations ./packages/db/migrations
COPY --from=builder /repo/packages/db/prisma.config.ts ./packages/db/

EXPOSE 3000

WORKDIR /repo/apps/api
CMD ["node", "dist/main.js"]
