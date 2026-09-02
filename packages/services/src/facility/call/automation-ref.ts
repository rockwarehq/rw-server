import prisma from "@rw/db";
import { createNameRef } from "../automation-ref-factory.js";

/** `callDefinitions` picker source — active definitions, name-ordered. */
export const callDefinitionsAutomationRef = createNameRef({
  key: "callDefinitions",
  findRows: (siteId) =>
    prisma.callDefinition.findMany({
      where: { archivedAt: null, ...(siteId ? { siteId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
