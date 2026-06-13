import prisma from "@rw/db";
import type { ObjectSchemaSource, Prisma } from "@rw/db";

import { errorResult, type ListResult, type ServiceResult } from "./types.js";

export interface ListEntityCatalogFilter {
  source?: ObjectSchemaSource;
  key?: string;
  name?: string;
  includeFields?: boolean;
  limit?: number;
  offset?: number;
}

export interface GetEntityCatalogInput {
  id?: string;
  key?: string;
  includeFields?: boolean;
}

function catalogVisibilityWhere(workspaceId: string): Prisma.ObjectSchemaWhereInput {
  return {
    isDeleted: false,
    OR: [{ workspaceId }, { workspaceId: null, isSystem: true }],
  };
}

function catalogInclude(includeFields = true) {
  return includeFields
    ? {
        fields: {
          where: { isDeleted: false },
          orderBy: [{ sortOrder: "asc" as const }, { name: "asc" as const }],
        },
      }
    : undefined;
}

export async function list(
  filter: ListEntityCatalogFilter,
  workspaceId: string,
): Promise<ListResult<unknown>> {
  const { source, key, name, includeFields = true, limit = 50, offset = 0 } = filter;
  const where: Prisma.ObjectSchemaWhereInput = {
    ...catalogVisibilityWhere(workspaceId),
    ...(source ? { source } : {}),
    ...(key ? { key } : {}),
    ...(name ? { name: { contains: name, mode: "insensitive" } } : {}),
  };

  const [schemas, total] = await Promise.all([
    prisma.objectSchema.findMany({
      where,
      include: catalogInclude(includeFields),
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    }),
    prisma.objectSchema.count({ where }),
  ]);

  return { data: schemas, total, limit: Number(limit), offset: Number(offset) };
}

export async function get(
  input: GetEntityCatalogInput,
  workspaceId: string,
): Promise<ServiceResult<unknown> | null> {
  if (!input.id && !input.key) return errorResult("CATALOG_LOOKUP_REQUIRED", "Catalog id or key is required");

  const schema = await prisma.objectSchema.findFirst({
    where: {
      ...catalogVisibilityWhere(workspaceId),
      ...(input.id ? { id: input.id } : { key: input.key }),
    },
    include: catalogInclude(input.includeFields ?? true),
  });
  return schema ? { data: schema } : null;
}
