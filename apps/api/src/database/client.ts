// Re-export the shared Prisma client at the "api" role's pool size. Existing
// imports `import prisma from "@/database/client.js"` continue to work; the
// underlying schema, generated client, and pool sizing live in @rw/db.
import { createPrismaClient } from "@rw/db";

const prisma = createPrismaClient("api");
export default prisma;
