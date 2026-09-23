import prisma from "@rw/db";

// Saved page views (Linear-style, ADR 0003 error contract): a view's saved
// definition is its shared default. Visibility "PRIVATE" = creator only;
// "WORKSPACE" = readable by every workspace member. Publishing new config to
// a WORKSPACE view ("Set default for everyone") is open to any workspace
// member; identity changes (name/description/visibility) and delete are
// creator-only (ShiftComment author-guard precedent).

// ============================================================================
// Types
// ============================================================================

export type SavedViewVisibility = "PRIVATE" | "WORKSPACE";

export interface CreateSavedViewInput {
  siteId: string;
  page: string;
  scopeId?: string | null;
  name: string;
  description?: string | null;
  visibility: SavedViewVisibility;
  config: Record<string, unknown>;
  createdById: string;
}

export interface UpdateSavedViewInput {
  actorId: string;
  name?: string;
  description?: string | null;
  visibility?: SavedViewVisibility;
  config?: Record<string, unknown>;
}

export interface ListSavedViewsFilter {
  siteId: string;
  page: string;
  scopeId?: string | null;
  userId: string;
}

const viewSelect = {
  id: true,
  siteId: true,
  page: true,
  scopeId: true,
  name: true,
  description: true,
  visibility: true,
  createdById: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ============================================================================
// Helpers
// ============================================================================

async function assertSiteExists(siteId: string) {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });
  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }
  return null;
}

async function loadForMutation(id: string) {
  const current = await prisma.savedView.findUnique({
    where: { id },
    select: {
      id: true,
      deletedAt: true,
      visibility: true,
      createdById: true,
    },
  });
  if (!current || current.deletedAt) {
    return { error: "Saved view not found", code: "SAVED_VIEW_NOT_FOUND" };
  }
  return { current };
}

// ============================================================================
// CRUD
// ============================================================================

export async function create(input: CreateSavedViewInput) {
  const siteError = await assertSiteExists(input.siteId);
  if (siteError) return { error: siteError.error, code: siteError.code };

  const name = input.name.trim();
  if (!name) {
    return { error: "View name is required", code: "NAME_REQUIRED" };
  }

  const view = await prisma.savedView.create({
    data: {
      siteId: input.siteId,
      page: input.page,
      scopeId: input.scopeId ?? null,
      name,
      description: input.description?.trim() || null,
      visibility: input.visibility,
      createdById: input.createdById,
      config: input.config,
    },
    select: viewSelect,
  });

  return { data: view };
}

/** Views visible to the caller: every WORKSPACE view plus their own PRIVATE ones. */
export async function list(filter: ListSavedViewsFilter) {
  const siteError = await assertSiteExists(filter.siteId);
  if (siteError) return { error: siteError.error, code: siteError.code };

  const views = await prisma.savedView.findMany({
    where: {
      siteId: filter.siteId,
      page: filter.page,
      scopeId: filter.scopeId ?? null,
      deletedAt: null,
      OR: [{ visibility: "WORKSPACE" }, { visibility: "PRIVATE", createdById: filter.userId }],
    },
    select: viewSelect,
    orderBy: { createdAt: "asc" },
  });

  return { data: views };
}

export async function update(id: string, input: UpdateSavedViewInput) {
  const loaded = await loadForMutation(id);
  if ("error" in loaded) return { error: loaded.error, code: loaded.code };
  const { current } = loaded;

  const isOwner = current.createdById === input.actorId;

  // PRIVATE views are entirely owner-only. On WORKSPACE views any member may
  // publish config ("Set default for everyone"); identity changes stay with
  // the creator.
  const changesIdentity = input.name !== undefined || input.description !== undefined || input.visibility !== undefined;
  if (current.visibility === "PRIVATE" && !isOwner) {
    return { error: "Only the creator can modify this view", code: "FORBIDDEN" };
  }
  if (changesIdentity && !isOwner) {
    return { error: "Only the creator can rename or reshare this view", code: "FORBIDDEN" };
  }

  const name = input.name?.trim();
  if (input.name !== undefined && !name) {
    return { error: "View name is required", code: "NAME_REQUIRED" };
  }

  const view = await prisma.savedView.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
    },
    select: viewSelect,
  });

  return { data: view };
}

export async function remove(id: string, input: { actorId: string }) {
  const loaded = await loadForMutation(id);
  if ("error" in loaded) return { error: loaded.error, code: loaded.code };
  const { current } = loaded;

  if (current.createdById !== input.actorId) {
    return { error: "Only the creator can delete this view", code: "FORBIDDEN" };
  }

  await prisma.savedView.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { data: { id } };
}
