import prisma, { Prisma } from "@rw/db";
import type { ProfileRow } from "./spec.js";

// Every site has one default profile, "Discrete": count by cycle, with the
// target a cycle time in seconds (ADR-0017). New stations and jobs get it
// unless another profile is picked, so a plant that only does normal
// discrete work never sets anything up.

export const DEFAULT_PROFILE_NAME = "Discrete";

type Client = Prisma.TransactionClient | typeof prisma;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * The site's default profile, made on first use for sites that have none
 * (new sites, seeds). Safe to call at the same time from two places: the
 * partial unique index on (siteId) WHERE isDefault lets only one insert win.
 */
export async function ensureDefaultProfile(siteId: string, client: Client = prisma): Promise<ProfileRow> {
  const found = await client.stationProfile.findFirst({ where: { siteId, isDefault: true } });
  if (found) return found;
  try {
    return await client.stationProfile.create({
      data: {
        siteId,
        // A site that already uses the name keeps it; the default gets a suffix.
        name: (await client.stationProfile.findFirst({ where: { siteId, name: DEFAULT_PROFILE_NAME } }))
          ? `${DEFAULT_PROFILE_NAME} (default)`
          : DEFAULT_PROFILE_NAME,
        description: "Counts by cycle; the target is a cycle time in seconds.",
        cycleMode: "DISCRETE",
        countedAs: "CYCLES",
        isDefault: true,
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await client.stationProfile.findFirst({ where: { siteId, isDefault: true } });
    if (!winner) throw err;
    return winner;
  }
}
