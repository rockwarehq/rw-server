import prisma from "@rw/db";
import { createNameRef } from "../facility/automation-ref-factory.js";

/** `decks` picker source — a site's report decks, name-ordered. */
export const decksAutomationRef = createNameRef({
  key: "decks",
  findRows: (siteId) =>
    prisma.reportDeck.findMany({
      where: siteId ? { siteId } : {},
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
