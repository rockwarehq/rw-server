import type { RefSource } from "@rw/automations";
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

/** `employees` picker source — active employees with access to the site, "First Last". */
export const employeesAutomationRef: RefSource = {
  key: "employees",
  async list(ctx) {
    const siteId = typeof ctx.siteId === "string" ? ctx.siteId : undefined;
    const rows = await prisma.employee.findMany({
      where: { status: "ACTIVE", ...(siteId ? { siteAccess: { some: { siteId, status: "ACTIVE" } } } : {}) },
      select: { id: true, version: { select: { firstName: true, lastName: true } } },
    });
    return rows
      .map((r) => ({ id: r.id, label: [r.version?.firstName, r.version?.lastName].filter(Boolean).join(" ") || r.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  },
};
