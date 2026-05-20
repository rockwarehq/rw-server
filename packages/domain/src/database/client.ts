// Lazy Prisma client accessor for @rw/domain.
//
// The @rw/db package memoizes a single PrismaClient keyed by the first
// createPrismaClient(role) call. The host process (apps/api/main.ts or
// apps/workers/main.ts) wins the race and seeds the cache with the
// correct role + pool size before any domain code runs.
//
// Files in @rw/domain pass any role here — the cache will return the
// already-initialized client. We pick "api" arbitrarily; it never wins
// because the host always calls createPrismaClient first.

import { createPrismaClient } from "@rw/db";

const prisma = createPrismaClient("api");
export default prisma;
