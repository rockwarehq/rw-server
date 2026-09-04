import prisma from "@rw/db";
import { createNameRef } from "../automation-ref-factory.js";

/** `statusReasons` picker source — every unarchived downtime reason, name-ordered. */
export const statusReasonsAutomationRef = createNameRef({
  key: "statusReasons",
  findRows: (siteId) =>
    prisma.statusReason.findMany({
      where: { archivedAt: null, ...(siteId ? { siteId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
