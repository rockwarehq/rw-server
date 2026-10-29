import prisma, { Prisma } from "@rw/db";
import type { OverheadPage, OverheadPagePriority } from "@rw/db";
import { auditRecord } from "../audit/index.js";

// Saved overhead pages (Settings → Overhead paging): a message plus the gateways
// and speaker settings to play it with, sent by hand with sendSavedPage().

type ServiceError = { error: string; code: string };

const DUPLICATE_NAME: ServiceError = {
  error: "An overhead page with this name already exists for this site",
  code: "DUPLICATE_NAME",
};
const NOT_FOUND: ServiceError = { error: "Overhead page not found", code: "OVERHEAD_PAGE_NOT_FOUND" };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const AUDITED_FIELDS = [
  "name",
  "text",
  "gatewayIds",
  "priority",
  "chimeBefore",
  "chimeAfter",
  "repeat",
  "voice",
  "speed",
  "archivedAt",
] as const;

async function auditPage(
  tx: Prisma.TransactionClient,
  change: "created" | "updated",
  after: OverheadPage,
  before?: OverheadPage,
) {
  const values = (page: OverheadPage) => ({ ...page, gatewayIds: [...page.gatewayIds].sort() });
  await auditRecord(tx, {
    change,
    entityType: "overhead-page",
    entityId: after.id,
    siteId: after.siteId,
    label: after.name,
    before: before ? values(before) : undefined,
    after: values(after),
    fields: AUDITED_FIELDS,
  });
}

/** What to say and how: shared by saved pages and one-off sends. */
export interface PageSettings {
  text: string;
  /** Empty or omitted = every speaker at the plant, resolved when sent. */
  gatewayIds?: string[];
  priority?: OverheadPagePriority;
  /** "off", a chime name, or null/undefined for the gateway's setting. */
  chimeBefore?: string | null;
  chimeAfter?: string | null;
  repeat?: number;
  voice?: string | null;
  speed?: number | null;
}

export interface CreatePageInput extends PageSettings {
  siteId: string;
  name: string;
}

export type UpdatePageInput = Partial<PageSettings> & { name?: string };

/** Every picked gateway must be on the site. None picked is fine: every speaker. */
export async function validateGateways(siteId: string, gatewayIds: string[] = []): Promise<ServiceError | null> {
  const ids = [...new Set(gatewayIds)];
  if (ids.length === 0) return null;
  const found = await prisma.gateway.findMany({ where: { id: { in: ids }, siteId }, select: { id: true } });
  const known = new Set(found.map((g) => g.id));
  const missing = ids.filter((id) => !known.has(id));
  return missing.length
    ? { error: `Gateway not found on this site: ${missing.join(", ")}`, code: "GATEWAY_NOT_FOUND" }
    : null;
}

export async function createPage(input: CreatePageInput): Promise<ServiceError | { data: OverheadPage }> {
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };

  const gatewayError = await validateGateways(input.siteId, input.gatewayIds);
  if (gatewayError) return gatewayError;

  try {
    const page = await prisma.$transaction(async (tx) => {
      const created = await tx.overheadPage.create({
        data: {
          siteId: input.siteId,
          name: input.name,
          text: input.text,
          gatewayIds: [...new Set(input.gatewayIds ?? [])],
          priority: input.priority,
          chimeBefore: input.chimeBefore ?? null,
          chimeAfter: input.chimeAfter ?? null,
          repeat: input.repeat,
          voice: input.voice ?? null,
          speed: input.speed ?? null,
        },
      });
      await auditPage(tx, "created", created);
      return created;
    });
    return { data: page };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function listPages(input: { siteId: string; limit?: number; offset?: number }) {
  const { siteId, limit = 100, offset = 0 } = input;
  const where = { siteId, archivedAt: null };
  const [data, total] = await Promise.all([
    prisma.overheadPage.findMany({
      where,
      orderBy: { name: "asc" },
      ...(limit > 0 ? { take: limit, skip: offset } : {}),
    }),
    prisma.overheadPage.count({ where }),
  ]);
  return { data, total, limit, offset };
}

/** null when missing or archived. */
export async function getPageById(id: string): Promise<{ data: OverheadPage } | null> {
  const page = await prisma.overheadPage.findUnique({ where: { id } });
  return page && !page.archivedAt ? { data: page } : null;
}

export async function updatePage(id: string, input: UpdatePageInput): Promise<ServiceError | { data: OverheadPage }> {
  const existing = await prisma.overheadPage.findUnique({ where: { id } });
  if (!existing || existing.archivedAt) return NOT_FOUND;

  if (input.gatewayIds) {
    const gatewayError = await validateGateways(existing.siteId, input.gatewayIds);
    if (gatewayError) return gatewayError;
  }

  try {
    const page = await prisma.$transaction(async (tx) => {
      const updated = await tx.overheadPage.update({
        where: { id },
        data: {
          name: input.name,
          text: input.text,
          gatewayIds: input.gatewayIds ? [...new Set(input.gatewayIds)] : undefined,
          priority: input.priority,
          chimeBefore: input.chimeBefore,
          chimeAfter: input.chimeAfter,
          repeat: input.repeat,
          voice: input.voice,
          speed: input.speed,
        },
      });
      await auditPage(tx, "updated", updated, existing);
      return updated;
    });
    return { data: page };
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME;
    throw err;
  }
}

export async function archivePage(id: string): Promise<ServiceError | { data: { success: true } }> {
  const existing = await prisma.overheadPage.findUnique({ where: { id } });
  if (!existing || existing.archivedAt) return NOT_FOUND;
  await prisma.$transaction(async (tx) => {
    const archived = await tx.overheadPage.update({ where: { id }, data: { archivedAt: new Date() } });
    await auditPage(tx, "updated", archived, existing);
  });
  return { data: { success: true } };
}
