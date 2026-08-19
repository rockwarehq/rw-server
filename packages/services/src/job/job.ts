import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { publishEntityEvent } from "../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../entity/registry.js";

// ============================================================================
// Types - Job
// ============================================================================

export interface CreateJobInput {
  siteId: string;
  name: string;
  description?: string;
  standardCycle?: number;
  productsPerCycle?: number;
  attrs?: Record<string, unknown>;
}

export interface UpdateJobInput {
  name?: string;
  description?: string;
  standardCycle?: number;
  productsPerCycle?: number;
  attrs?: Record<string, unknown>;
}

export interface ListJobsFilter {
  siteId?: string;
  /** Free-text search across name and description (case-insensitive contains, OR) */
  q?: string;
  name?: string;
  /** Only return jobs that have at least one JobProduct with a matching productId */
  productIds?: string[];
  view?: "full" | "slim";
  limit?: number;
  offset?: number;
}

// ============================================================================
// Types - JobTool
// ============================================================================

export interface AddToolInput {
  jobId: string;
  toolId: string;
}

// ============================================================================
// Types - JobProduct
// ============================================================================

export interface AddItemInput {
  jobId: string;
  productId: string;
  toolId?: string;
  toolCavityId?: string;
  quantity?: number;
}

export interface UpdateItemInput {
  isActive?: boolean;
  toolId?: string | null;
  toolCavityId?: string | null;
  quantity?: number;
}

// ============================================================================
// Job CRUD Operations
// ============================================================================

/**
 * Create a new job with initial version (version 1)
 */
export async function create(input: CreateJobInput) {
  const { siteId, name, description, standardCycle, productsPerCycle, attrs } = input;

  // Verify site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Create job and initial version in transaction
  const job = await prisma.$transaction(async (tx) => {
    // 1. Create Job entity
    const j = await tx.job.create({
      data: { siteId },
    });

    // 2. Create initial JobVersion (version 1)
    const version = await tx.jobVersion.create({
      data: {
        jobId: j.id,
        version: 1,
        name,
        description: description ?? null,
        standardCycle: standardCycle ?? null,
        productsPerCycle: productsPerCycle ?? 1,
        attrs: attrs ?? {},
      },
    });

    // 3. Link version as current and return
    return tx.job.update({
      where: { id: j.id },
      data: { currentVersionId: version.id },
      include: {
        currentVersion: true,
        site: { select: { id: true, name: true } },
        _count: { select: { tools: true, jobProducts: true, orders: true, versions: true } },
      },
    });
  });

  publishEntityEvent({
    action: "created",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: job.id,
    siteId: job.siteId,
    workspaceId: site.workspaceId,
  });

  return { data: job };
}

/**
 * List jobs with optional filtering
 */
export async function list(filter: ListJobsFilter = {}) {
  const { siteId, q, name, productIds, view = "full", limit = 50, offset = 0 } = filter;

  const where: Prisma.JobWhereInput = {
    deletedAt: null,
  };

  if (siteId) {
    where.siteId = siteId;
  }

  // Free-text search OR'd across the columns shown in the UI.
  if (q) {
    where.currentVersion = {
      OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }],
    };
  } else if (name) {
    where.currentVersion = {
      name: { contains: name, mode: "insensitive" },
    };
  }

  // Filter jobs that have at least one JobProduct matching the given product IDs
  if (productIds && productIds.length > 0) {
    where.jobProducts = {
      some: {
        productId: { in: productIds },
        deletedAt: null,
      },
    };
  }

  const pagination = {
    ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
    skip: Number(offset),
    orderBy: { createdAt: "desc" } as const,
  };

  if (view === "slim") {
    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        select: {
          id: true,
          currentVersion: { select: { name: true, description: true } },
        },
        ...pagination,
      }),
      prisma.job.count({ where }),
    ]);

    return {
      data: jobs.map((j) => ({
        id: j.id,
        name: j.currentVersion?.name ?? "",
        description: j.currentVersion?.description ?? null,
      })),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      include: {
        currentVersion: true,
        site: { select: { id: true, name: true } },
        _count: { select: { tools: true, jobProducts: true, orders: true, versions: true } },
      },
      ...pagination,
    }),
    prisma.job.count({ where }),
  ]);

  return {
    data: jobs,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get job by ID with current version, tools, and items
 */
export async function getById(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      currentVersion: true,
      site: { select: { id: true, name: true } },
      tools: {
        where: { deletedAt: null },
        include: {
          tool: {
            include: {
              currentVersion: true,
              toolCavities: {
                where: { deletedAt: null },
                include: { currentVersion: true },
              },
            },
          },
        },
      },
      jobProducts: {
        where: { deletedAt: null },
        include: {
          currentVersion: true,
          product: {
            include: {
              currentVersion: true,
              // BOM materials so the operator screen can list short code +
              // description per material and offer alt-group swaps.
              materials: {
                where: { archivedAt: null },
                include: {
                  currentVersion: true,
                  material: { include: { currentVersion: true } },
                  altGroup: true,
                },
              },
            },
          },
          tool: {
            include: {
              currentVersion: true,
            },
          },
          toolCavity: {
            include: {
              currentVersion: true,
            },
          },
        },
      },
      _count: { select: { tools: true, jobProducts: true, orders: true, versions: true } },
    },
  });

  if (!job) {
    return null;
  }

  if (job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  return { data: job };
}

/**
 * Update job (creates new version version)
 */
export async function update(id: string, input: UpdateJobInput) {
  const { name, description, standardCycle, productsPerCycle, attrs } = input;

  // Get current job with version
  const current = await prisma.job.findUnique({
    where: { id },
    include: { currentVersion: true, site: { select: { workspaceId: true } } },
  });

  if (!current) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  if (!current.currentVersion) {
    return { error: "Job has no current version", code: "NO_CURRENT_VERSION" };
  }

  const currentVersion = current.currentVersion;

  // Get next version number
  const latestVersion = await prisma.jobVersion.findFirst({
    where: { jobId: id },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestVersion?.version ?? 0) + 1;

  // Create new version with merged data
  const job = await prisma.$transaction(async (tx) => {
    const version = await tx.jobVersion.create({
      data: {
        jobId: id,
        version: nextVersion,
        name: name ?? currentVersion.name,
        description: description !== undefined ? description : currentVersion.description,
        standardCycle: standardCycle !== undefined ? standardCycle : currentVersion.standardCycle,
        productsPerCycle: productsPerCycle !== undefined ? productsPerCycle : currentVersion.productsPerCycle,
        attrs: attrs !== undefined ? attrs : (currentVersion.attrs as Record<string, unknown>),
      },
    });

    return tx.job.update({
      where: { id },
      data: { currentVersionId: version.id },
      include: {
        currentVersion: true,
        site: { select: { id: true, name: true } },
        _count: { select: { tools: true, jobProducts: true, orders: true, versions: true } },
      },
    });
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: job.id,
    siteId: job.siteId,
    workspaceId: current.site.workspaceId,
    changedFields: Object.entries({ name, description, standardCycle, productsPerCycle })
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  });

  return { data: job };
}

/**
 * Soft delete job (sets deletedAt)
 */
export async function remove(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      site: { select: { workspaceId: true } },
      _count: { select: { orders: true } },
    },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (job.deletedAt) {
    return { error: "Job already deleted", code: "JOB_DELETED" };
  }

  if (job._count.orders > 0) {
    return {
      error: "Cannot delete job that has work orders. Delete work orders first.",
      code: "HAS_ORDERS",
    };
  }

  await prisma.job.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  publishEntityEvent({
    action: "deleted",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: job.id,
    siteId: job.siteId,
    workspaceId: job.site.workspaceId,
  });

  return { success: true };
}

/**
 * Check if job exists
 */
export async function exists(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  return job !== null && job.deletedAt === null;
}

// ============================================================================
// JobTool Operations (linking tools to jobs)
// ============================================================================

/**
 * Add a tool to a job
 */
export async function addTool(input: AddToolInput) {
  const { jobId, toolId } = input;

  // Verify job exists and is not deleted
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, siteId: true, deletedAt: true, site: { select: { workspaceId: true } } },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  // Verify tool exists and is not deleted
  const tool = await prisma.tool.findUnique({
    where: { id: toolId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!tool) {
    return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
  }

  if (tool.deletedAt) {
    return { error: "Tool has been deleted", code: "TOOL_DELETED" };
  }

  // Verify same site
  if (job.siteId !== tool.siteId) {
    return { error: "Job and tool must belong to the same site", code: "SITE_MISMATCH" };
  }

  // Check if already linked
  const existing = await prisma.jobTool.findUnique({
    where: { jobId_toolId: { jobId, toolId } },
  });

  if (existing && !existing.deletedAt) {
    return { error: "Tool is already linked to this job", code: "ALREADY_LINKED" };
  }

  // Create or restore JobTool
  let jobTool: Awaited<ReturnType<typeof prisma.jobTool.update>>;

  if (existing) {
    // Restore soft-deleted link
    jobTool = await prisma.jobTool.update({
      where: { id: existing.id },
      data: { deletedAt: null, isActive: true },
      include: {
        tool: {
          include: {
            currentVersion: true,
            toolCavities: {
              where: { deletedAt: null },
              include: { currentVersion: true },
            },
          },
        },
      },
    });
  } else {
    // Create new link
    jobTool = await prisma.jobTool.create({
      data: { jobId, toolId, isActive: true },
      include: {
        tool: {
          include: {
            currentVersion: true,
            toolCavities: {
              where: { deletedAt: null },
              include: { currentVersion: true },
            },
          },
        },
      },
    });
  }

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: job.id,
    siteId: job.siteId,
    workspaceId: job.site.workspaceId,
    changedFields: ["tools"],
  });
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Tool,
    entityId: tool.id,
    siteId: tool.siteId,
    workspaceId: job.site.workspaceId,
    changedFields: ["jobs"],
  });

  return { data: jobTool };
}

/**
 * Remove a tool from a job (soft delete)
 */
export async function removeTool(jobId: string, toolId: string) {
  const jobTool = await prisma.jobTool.findUnique({
    where: { jobId_toolId: { jobId, toolId } },
    include: { job: { include: { site: { select: { workspaceId: true } } } }, tool: true },
  });

  if (!jobTool) {
    return { error: "Tool is not linked to this job", code: "NOT_LINKED" };
  }

  if (jobTool.deletedAt) {
    return { error: "Link already deleted", code: "ALREADY_DELETED" };
  }

  await prisma.jobTool.update({
    where: { id: jobTool.id },
    data: { deletedAt: new Date() },
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: jobTool.jobId,
    siteId: jobTool.job.siteId,
    workspaceId: jobTool.job.site.workspaceId,
    changedFields: ["tools"],
  });
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Tool,
    entityId: jobTool.toolId,
    siteId: jobTool.tool.siteId,
    workspaceId: jobTool.job.site.workspaceId,
    changedFields: ["jobs"],
  });

  return { success: true };
}

/**
 * List tools linked to a job
 */
export async function listTools(jobId: string) {
  // Verify job exists
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, deletedAt: true },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  const jobTools = await prisma.jobTool.findMany({
    where: {
      jobId,
      deletedAt: null,
    },
    include: {
      tool: {
        include: {
          currentVersion: true,
          toolCavities: {
            where: { deletedAt: null },
            include: {
              currentVersion: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return { data: jobTools };
}

// ============================================================================
// JobProduct Operations (linking products to jobs)
// ============================================================================

/**
 * Add a product (item) to a job
 */
export async function addItem(input: AddItemInput) {
  const { jobId, productId, toolId, toolCavityId, quantity } = input;

  // Verify job exists and is not deleted
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, siteId: true, deletedAt: true, site: { select: { workspaceId: true } } },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  // Verify product exists and is not deleted
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (product.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  // Verify same site
  if (job.siteId !== product.siteId) {
    return { error: "Job and product must belong to the same site", code: "SITE_MISMATCH" };
  }

  // If toolId provided, verify it
  if (toolId) {
    const tool = await prisma.tool.findUnique({
      where: { id: toolId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!tool) {
      return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
    }

    if (tool.deletedAt) {
      return { error: "Tool has been deleted", code: "TOOL_DELETED" };
    }

    if (job.siteId !== tool.siteId) {
      return { error: "Tool must belong to the same site as job", code: "TOOL_SITE_MISMATCH" };
    }
  }

  // If toolCavityId provided, verify it
  if (toolCavityId) {
    const cavity = await prisma.toolCavity.findUnique({
      where: { id: toolCavityId },
      select: { id: true, toolId: true, deletedAt: true },
    });

    if (!cavity) {
      return { error: "Tool cavity not found", code: "CAVITY_NOT_FOUND" };
    }

    if (cavity.deletedAt) {
      return { error: "Tool cavity has been deleted", code: "CAVITY_DELETED" };
    }
  }

  // Create JobProduct with version
  const jobProduct = await prisma.$transaction(async (tx) => {
    // 1. Create JobProduct entity
    const jp = await tx.jobProduct.create({
      data: {
        jobId,
        productId,
        toolId: toolId ?? null,
        toolCavityId: toolCavityId ?? null,
      },
    });

    // 2. Create initial JobProductVersion (version 1)
    const version = await tx.jobProductVersion.create({
      data: {
        jobProductId: jp.id,
        version: 1,
        isActive: true,
        quantity: quantity ?? 1,
      },
    });

    // 3. Link version as current and return
    return tx.jobProduct.update({
      where: { id: jp.id },
      data: { currentVersionId: version.id },
      include: {
        currentVersion: true,
        product: {
          include: {
            currentVersion: true,
          },
        },
        tool: {
          include: {
            currentVersion: true,
          },
        },
        toolCavity: {
          include: {
            currentVersion: true,
          },
        },
      },
    });
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: job.id,
    siteId: job.siteId,
    workspaceId: job.site.workspaceId,
    changedFields: ["products"],
  });
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Product,
    entityId: product.id,
    siteId: product.siteId,
    workspaceId: job.site.workspaceId,
    changedFields: ["jobs"],
  });

  return { data: jobProduct };
}

/**
 * Update a job product (creates new version version)
 */
export async function updateItem(itemId: string, input: UpdateItemInput) {
  const { isActive, toolId, toolCavityId, quantity } = input;

  // Get current item with version
  const current = await prisma.jobProduct.findUnique({
    where: { id: itemId },
    include: {
      currentVersion: true,
      job: { select: { id: true, siteId: true, deletedAt: true, site: { select: { workspaceId: true } } } },
    },
  });

  if (!current) {
    return { error: "Job product not found", code: "ITEM_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Job product has been deleted", code: "ITEM_DELETED" };
  }

  if (current.job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  if (!current.currentVersion) {
    return { error: "Job product has no current version", code: "NO_CURRENT_VERSION" };
  }

  const currentVersion = current.currentVersion;

  // Validate toolId if changing
  if (toolId !== undefined && toolId !== null) {
    const tool = await prisma.tool.findUnique({
      where: { id: toolId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!tool) {
      return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
    }

    if (tool.deletedAt) {
      return { error: "Tool has been deleted", code: "TOOL_DELETED" };
    }

    if (current.job.siteId !== tool.siteId) {
      return { error: "Tool must belong to the same site as job", code: "TOOL_SITE_MISMATCH" };
    }
  }

  // Validate toolCavityId if changing
  if (toolCavityId !== undefined && toolCavityId !== null) {
    const cavity = await prisma.toolCavity.findUnique({
      where: { id: toolCavityId },
      select: { id: true, toolId: true, deletedAt: true },
    });

    if (!cavity) {
      return { error: "Tool cavity not found", code: "CAVITY_NOT_FOUND" };
    }

    if (cavity.deletedAt) {
      return { error: "Tool cavity has been deleted", code: "CAVITY_DELETED" };
    }
  }

  // Get next version number
  const latestVersion = await prisma.jobProductVersion.findFirst({
    where: { jobProductId: itemId },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestVersion?.version ?? 0) + 1;

  // Create new version and update item
  const jobProduct = await prisma.$transaction(async (tx) => {
    const version = await tx.jobProductVersion.create({
      data: {
        jobProductId: itemId,
        version: nextVersion,
        isActive: isActive !== undefined ? isActive : currentVersion.isActive,
        quantity: quantity !== undefined ? quantity : currentVersion.quantity,
      },
    });

    return tx.jobProduct.update({
      where: { id: itemId },
      data: {
        currentVersionId: version.id,
        toolId: toolId !== undefined ? toolId : undefined,
        toolCavityId: toolCavityId !== undefined ? toolCavityId : undefined,
      },
      include: {
        currentVersion: true,
        product: {
          include: {
            currentVersion: true,
          },
        },
        tool: {
          include: {
            currentVersion: true,
          },
        },
        toolCavity: {
          include: {
            currentVersion: true,
          },
        },
      },
    });
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: current.jobId,
    siteId: current.job.siteId,
    workspaceId: current.job.site.workspaceId,
    changedFields: ["products"],
  });
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Product,
    entityId: current.productId,
    siteId: current.job.siteId,
    workspaceId: current.job.site.workspaceId,
    changedFields: ["jobs"],
  });

  return { data: jobProduct };
}

/**
 * Remove a job product (soft delete)
 */
export async function removeItem(itemId: string) {
  const item = await prisma.jobProduct.findUnique({
    where: { id: itemId },
    include: { job: { include: { site: { select: { workspaceId: true } } } } },
  });

  if (!item) {
    return { error: "Job product not found", code: "ITEM_NOT_FOUND" };
  }

  if (item.deletedAt) {
    return { error: "Job product already deleted", code: "ITEM_DELETED" };
  }

  await prisma.jobProduct.update({
    where: { id: itemId },
    data: { deletedAt: new Date() },
  });

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Job,
    entityId: item.jobId,
    siteId: item.job.siteId,
    workspaceId: item.job.site.workspaceId,
    changedFields: ["products"],
  });
  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Product,
    entityId: item.productId,
    siteId: item.job.siteId,
    workspaceId: item.job.site.workspaceId,
    changedFields: ["jobs"],
  });

  return { success: true };
}

/**
 * List products for a job
 */
export async function listItems(jobId: string) {
  // Verify job exists
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, deletedAt: true },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  const jobProducts = await prisma.jobProduct.findMany({
    where: {
      jobId,
      deletedAt: null,
    },
    include: {
      currentVersion: true,
      product: {
        include: {
          currentVersion: true,
        },
      },
      tool: {
        include: {
          currentVersion: true,
        },
      },
      toolCavity: {
        include: {
          currentVersion: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return { data: jobProducts };
}

/**
 * Given a list of product IDs, return the jobs capable of producing each.
 * Returns a map of productId → [{ jobId, jobName }].
 */
export async function jobsByProductIds(siteId: string, productIds: string[]) {
  if (productIds.length === 0) return { data: {} };

  const jobProducts = await prisma.jobProduct.findMany({
    where: {
      deletedAt: null,
      productId: { in: productIds },
      job: { siteId, deletedAt: null },
    },
    select: {
      productId: true,
      job: {
        select: {
          id: true,
          currentVersion: { select: { name: true } },
        },
      },
    },
  });

  const map: Record<string, { jobId: string; jobName: string }[]> = {};
  for (const jp of jobProducts) {
    if (!map[jp.productId]) map[jp.productId] = [];
    // Deduplicate — same job can appear multiple times via different cavities
    if (map[jp.productId].some((e) => e.jobId === jp.job.id)) continue;
    map[jp.productId].push({ jobId: jp.job.id, jobName: jp.job.currentVersion?.name ?? "" });
  }

  return { data: map };
}
