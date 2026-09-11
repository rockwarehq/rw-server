import type { Prisma } from "@rw/db";

/** What every module handler needs to rewrite its facts for one amendment. */
export interface AmendContext {
  tx: Prisma.TransactionClient;
  /** The JobHistoryAmendment row this rewrite belongs to (created before the handlers run). */
  amendmentId: string;
  siteId: string;
  stationId: string;
  workcenterId: string | null;
  from: Date;
  /** `to`, or now for an open-ended amendment. */
  toEff: Date;
  /** The job asserted over the window; null = the station ran nothing. */
  job: {
    id: string;
    versionId: string;
    standardCycle: number | null;
    standardQuantity: number | null;
    quantityUnit: string;
  } | null;
}
