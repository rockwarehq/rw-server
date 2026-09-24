import prisma, { type Prisma } from "@rw/db";
import type { DocumentTargetType } from "@rw/db";
import { applyLabelFilter, collectDocumentTreeIds, documentInclude, toDocument, type LabelFilter } from "./shared.js";

/*
 * Knowledge context: every document that belongs to a thing, directly or
 * through what it is made of and runs with. A link only says "this document
 * belongs to that record"; what someone must DO with a document (a checklist
 * at a trigger, confirm-read before a run) is a separate requirement rule for
 * a later iteration, which will call this resolver with a proposed job before
 * a job change and pin the current file version it returns.
 *
 * Expansion, most specific first:
 *   STATION     → station, its job (a proposed jobId, else the current one)
 *                 expanded as JOB, then its workcenter and site
 *   JOB         → job, its products, its tools (job tools and per-product
 *                 tools), then the products' materials
 *   PRODUCT     → product, then its materials
 *   WORKCENTER  → workcenter, then its site
 *   TOOL, MATERIAL, SITE → themselves
 *
 * A linked FOLDER stands for everything inside it, now and later: it expands
 * to its READY files at any depth, each marked with the folder it came
 * through. Every item says which records it reached the context through
 * (`via`, in expansion order), so a reader can tell a job's setup sheet from
 * a site-wide policy, and carries its current version id for pinning.
 */

export interface ContextTarget {
  targetType: DocumentTargetType;
  targetId: string;
  name: string;
}

export interface ContextOptions extends LabelFilter {
  /** For a STATION: the job to resolve instead of the one it runs now. */
  jobId?: string | null;
}

type ServiceError = { error: string; code: string };

function add(targets: ContextTarget[], target: ContextTarget) {
  if (!targets.some((t) => t.targetType === target.targetType && t.targetId === target.targetId)) {
    targets.push(target);
  }
}

const orName = (...names: (string | null | undefined)[]) => names.find((name) => !!name) ?? "Untitled";

async function jobTargets(jobId: string, siteId: string | null): Promise<ContextTarget[] | ServiceError> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      siteId: true,
      deletedAt: true,
      currentVersion: { select: { name: true } },
      tools: {
        where: { deletedAt: null, tool: { deletedAt: null } },
        select: { tool: { select: { id: true, currentVersion: { select: { name: true } } } } },
      },
      jobProducts: {
        where: { deletedAt: null, product: { deletedAt: null } },
        select: {
          product: {
            select: {
              id: true,
              currentVersion: { select: { name: true, sku: true } },
              materials: {
                where: { archivedAt: null, material: { deletedAt: null } },
                select: {
                  material: {
                    select: { id: true, currentVersion: { select: { name: true, materialNumber: true } } },
                  },
                },
              },
            },
          },
          tool: { select: { id: true, deletedAt: true, currentVersion: { select: { name: true } } } },
        },
      },
    },
  });
  if (!job || job.deletedAt || (siteId && job.siteId !== siteId)) {
    return { error: "Job not found", code: "TARGET_NOT_FOUND" };
  }

  const targets: ContextTarget[] = [];
  add(targets, { targetType: "JOB", targetId: job.id, name: orName(job.currentVersion?.name) });
  for (const { product } of job.jobProducts) {
    add(targets, {
      targetType: "PRODUCT",
      targetId: product.id,
      name: orName(product.currentVersion?.name, product.currentVersion?.sku),
    });
  }
  const tools = [
    ...job.tools.map((row) => row.tool),
    ...job.jobProducts.flatMap((row) => (row.tool && !row.tool.deletedAt ? [row.tool] : [])),
  ];
  for (const tool of tools) {
    add(targets, { targetType: "TOOL", targetId: tool.id, name: orName(tool.currentVersion?.name) });
  }
  for (const { product } of job.jobProducts) {
    for (const { material } of product.materials) {
      add(targets, {
        targetType: "MATERIAL",
        targetId: material.id,
        name: orName(material.currentVersion?.name, material.currentVersion?.materialNumber),
      });
    }
  }
  return targets;
}

/** The records a context spans, most specific first, with display names. */
export async function contextTargets(
  root: { targetType: DocumentTargetType; targetId: string },
  options: ContextOptions = {},
): Promise<{ siteId: string; targets: ContextTarget[] } | ServiceError> {
  const { targetType, targetId } = root;
  const notFound = { error: "Target not found", code: "TARGET_NOT_FOUND" };

  switch (targetType) {
    case "STATION": {
      const station = await prisma.station.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          name: true,
          siteId: true,
          deletedAt: true,
          currentJobId: true,
          workcenter: { select: { id: true, name: true } },
          site: { select: { id: true, name: true } },
        },
      });
      if (!station || station.deletedAt) return notFound;
      const targets: ContextTarget[] = [{ targetType: "STATION", targetId: station.id, name: station.name }];
      const jobId = options.jobId !== undefined ? options.jobId : station.currentJobId;
      if (jobId) {
        const job = await jobTargets(jobId, station.siteId);
        if ("error" in job) return job;
        for (const target of job) add(targets, target);
      }
      if (station.workcenter) {
        add(targets, { targetType: "WORKCENTER", targetId: station.workcenter.id, name: station.workcenter.name });
      }
      add(targets, { targetType: "SITE", targetId: station.site.id, name: station.site.name });
      return { siteId: station.siteId, targets };
    }
    case "JOB": {
      const job = await prisma.job.findUnique({ where: { id: targetId }, select: { siteId: true } });
      if (!job) return notFound;
      const targets = await jobTargets(targetId, job.siteId);
      if ("error" in targets) return targets;
      return { siteId: job.siteId, targets };
    }
    case "PRODUCT": {
      const product = await prisma.product.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          siteId: true,
          deletedAt: true,
          currentVersion: { select: { name: true, sku: true } },
          materials: {
            where: { archivedAt: null, material: { deletedAt: null } },
            select: {
              material: { select: { id: true, currentVersion: { select: { name: true, materialNumber: true } } } },
            },
          },
        },
      });
      if (!product || product.deletedAt) return notFound;
      const targets: ContextTarget[] = [
        {
          targetType: "PRODUCT",
          targetId: product.id,
          name: orName(product.currentVersion?.name, product.currentVersion?.sku),
        },
      ];
      for (const { material } of product.materials) {
        add(targets, {
          targetType: "MATERIAL",
          targetId: material.id,
          name: orName(material.currentVersion?.name, material.currentVersion?.materialNumber),
        });
      }
      return { siteId: product.siteId, targets };
    }
    case "TOOL": {
      const tool = await prisma.tool.findUnique({
        where: { id: targetId },
        select: { id: true, siteId: true, deletedAt: true, currentVersion: { select: { name: true } } },
      });
      if (!tool || tool.deletedAt) return notFound;
      return {
        siteId: tool.siteId,
        targets: [{ targetType: "TOOL", targetId: tool.id, name: orName(tool.currentVersion?.name) }],
      };
    }
    case "MATERIAL": {
      const material = await prisma.material.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          siteId: true,
          deletedAt: true,
          currentVersion: { select: { name: true, materialNumber: true } },
        },
      });
      if (!material || material.deletedAt) return notFound;
      return {
        siteId: material.siteId,
        targets: [
          {
            targetType: "MATERIAL",
            targetId: material.id,
            name: orName(material.currentVersion?.name, material.currentVersion?.materialNumber),
          },
        ],
      };
    }
    case "WORKCENTER": {
      const workcenter = await prisma.workcenter.findUnique({
        where: { id: targetId },
        select: { id: true, name: true, siteId: true, site: { select: { id: true, name: true } } },
      });
      if (!workcenter) return notFound;
      return {
        siteId: workcenter.siteId,
        targets: [
          { targetType: "WORKCENTER", targetId: workcenter.id, name: workcenter.name },
          { targetType: "SITE", targetId: workcenter.site.id, name: workcenter.site.name },
        ],
      };
    }
    case "SITE": {
      const site = await prisma.site.findUnique({ where: { id: targetId }, select: { id: true, name: true } });
      if (!site) return notFound;
      return { siteId: site.id, targets: [{ targetType: "SITE", targetId: site.id, name: site.name }] };
    }
  }
}

/** Every READY file in a context, most specific first, with how it got there. */
export async function resolveContext(
  root: { targetType: DocumentTargetType; targetId: string },
  options: ContextOptions = {},
) {
  const scope = await contextTargets(root, options);
  if ("error" in scope) return scope;
  const { siteId, targets } = scope;

  // Workspace-level documents (no site) belong to every site's context.
  const readable: Prisma.DocumentWhereInput = {
    deletedAt: null,
    status: "READY",
    OR: [{ siteId: null }, { siteId }],
  };
  const links = await prisma.documentLink.findMany({
    where: {
      OR: targets.map((target) => ({ targetType: target.targetType, targetId: target.targetId })),
      document: readable,
    },
    select: { targetType: true, targetId: true, document: { select: { id: true, kind: true, name: true } } },
  });

  // Which targets reached each file, and which linked folder (if any) it sits in.
  const rank = (link: { targetType: DocumentTargetType; targetId: string }) =>
    targets.findIndex((t) => t.targetType === link.targetType && t.targetId === link.targetId);
  const reached = new Map<string, { via: Set<number>; folder: { id: string; name: string } | null }>();
  const note = (fileId: string, targetIndex: number, folder: { id: string; name: string } | null) => {
    const entry = reached.get(fileId) ?? { via: new Set<number>(), folder };
    entry.via.add(targetIndex);
    // A direct link outranks arriving through a folder.
    if (!folder) entry.folder = null;
    reached.set(fileId, entry);
  };
  for (const link of links) {
    const index = rank(link);
    if (link.document.kind === "FILE") {
      note(link.document.id, index, null);
      continue;
    }
    const inside = (await collectDocumentTreeIds(link.document.id)).filter((id) => id !== link.document.id);
    for (const id of inside) note(id, index, { id: link.document.id, name: link.document.name });
  }

  const where: Prisma.DocumentWhereInput = { ...readable, kind: "FILE", id: { in: [...reached.keys()] } };
  applyLabelFilter(where, options);
  const documents = reached.size > 0 ? await prisma.document.findMany({ where, include: documentInclude }) : [];

  const items = documents.flatMap((document) => {
    const entry = reached.get(document.id);
    if (!entry) return [];
    const via = [...entry.via].sort((a, b) => a - b);
    return [
      {
        document: toDocument(document),
        currentFileId: document.currentFileId,
        via: via.flatMap((index) => targets[index] ?? []),
        folder: entry.folder,
        rank: via[0] ?? 0,
      },
    ];
  });
  items.sort((a, b) => a.rank - b.rank || a.document.name.localeCompare(b.document.name));

  return { data: items.map(({ rank: _rank, ...item }) => item), targets, siteId };
}

/** Display names for link targets; a deleted or missing target gets null. */
export async function targetNames(
  links: { targetType: DocumentTargetType; targetId: string }[],
): Promise<Map<string, string | null>> {
  const idsOf = (type: DocumentTargetType) => [
    ...new Set(links.filter((link) => link.targetType === type).map((link) => link.targetId)),
  ];
  const names = new Map<string, string | null>();
  const put = (type: DocumentTargetType, id: string, name: string | null) => names.set(`${type}:${id}`, name);

  const [sites, workcenters, stations, jobs, tools, products, materials] = await Promise.all([
    prisma.site.findMany({ where: { id: { in: idsOf("SITE") } }, select: { id: true, name: true } }),
    prisma.workcenter.findMany({ where: { id: { in: idsOf("WORKCENTER") } }, select: { id: true, name: true } }),
    prisma.station.findMany({
      where: { id: { in: idsOf("STATION") }, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.job.findMany({
      where: { id: { in: idsOf("JOB") }, deletedAt: null },
      select: { id: true, currentVersion: { select: { name: true } } },
    }),
    prisma.tool.findMany({
      where: { id: { in: idsOf("TOOL") }, deletedAt: null },
      select: { id: true, currentVersion: { select: { name: true } } },
    }),
    prisma.product.findMany({
      where: { id: { in: idsOf("PRODUCT") }, deletedAt: null },
      select: { id: true, currentVersion: { select: { name: true, sku: true } } },
    }),
    prisma.material.findMany({
      where: { id: { in: idsOf("MATERIAL") }, deletedAt: null },
      select: { id: true, currentVersion: { select: { name: true, materialNumber: true } } },
    }),
  ]);
  for (const row of sites) put("SITE", row.id, row.name);
  for (const row of workcenters) put("WORKCENTER", row.id, row.name);
  for (const row of stations) put("STATION", row.id, row.name);
  for (const row of jobs) put("JOB", row.id, orName(row.currentVersion?.name));
  for (const row of tools) put("TOOL", row.id, orName(row.currentVersion?.name));
  for (const row of products) put("PRODUCT", row.id, orName(row.currentVersion?.name, row.currentVersion?.sku));
  for (const row of materials) {
    put("MATERIAL", row.id, orName(row.currentVersion?.name, row.currentVersion?.materialNumber));
  }
  return names;
}
