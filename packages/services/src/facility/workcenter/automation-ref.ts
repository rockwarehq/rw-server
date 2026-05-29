import prisma from "@rw/db";
import { createSiteScopedNameRef } from "../automation-ref-factory.js";

/** `workCenters` picker source — every workcenter under any site in the workspace, name-ordered. */
export const createWorkcentersAutomationRef = createSiteScopedNameRef({
  key: "workCenters",
  findRows: (workspaceId) =>
    prisma.workcenter.findMany({
      where: { site: { workspaceId } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
