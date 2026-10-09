import prisma from "@rw/db";
import { createNameRef } from "../../facility/automation-ref-factory.js";

/** `gateways` picker source — the site's gateways that aren't disabled, name-ordered. */
export const gatewaysAutomationRef = createNameRef({
  key: "gateways",
  findRows: (siteId) =>
    prisma.gateway.findMany({
      where: { status: { not: "DISABLED" }, ...(siteId ? { siteId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
