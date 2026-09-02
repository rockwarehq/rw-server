import prisma from "@rw/db";
import { createNameRef } from "../automation-ref-factory.js";

/** `productionModes` picker source — active modes, name-ordered. */
export const productionModesAutomationRef = createNameRef({
  key: "productionModes",
  findRows: (siteId) =>
    prisma.productionMode.findMany({
      where: { archivedAt: null, ...(siteId ? { siteId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
