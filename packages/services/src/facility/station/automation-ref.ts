import prisma from "@rw/db";
import { createSiteScopedNameRef } from "../automation-ref-factory.js";

/** `stations` picker source — every non-deleted station under any site in the workspace, name-ordered. */
export const createStationsAutomationRef = createSiteScopedNameRef({
  key: "stations",
  findRows: (workspaceId) =>
    prisma.station.findMany({
      where: { site: { workspaceId }, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
