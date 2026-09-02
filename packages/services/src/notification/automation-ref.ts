import prisma from "@rw/db";
import { createNameRef } from "../facility/automation-ref-factory.js";

/** `notificationGroups` picker source — active groups, name-ordered. */
export const notificationGroupsAutomationRef = createNameRef({
  key: "notificationGroups",
  findRows: (siteId) =>
    prisma.notificationGroup.findMany({
      where: { archivedAt: null, ...(siteId ? { siteId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
