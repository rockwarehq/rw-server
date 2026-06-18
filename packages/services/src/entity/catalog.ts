import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import type { GetEntityCatalogInput, ListEntityCatalogFilter } from "./catalog.types.js";
import type { EntityCatalogEntry, EntityCatalogField } from "./registry.types.js";
import { errorResult, type EntityScope, type ListResult, type ServiceResult } from "./types.js";
import { systemEntityCatalogEntries, systemEntityCatalogEntryByKey } from "./registry.js";

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

function documentFieldToCatalogField(field: {
  id: string;
  name: string;
  key: string;
  label: string;
  description: string | null;
  type: EntityCatalogField["type"];
  refSchemaId: string | null;
  isList: boolean;
  required: boolean;
  sortOrder: number;
}): EntityCatalogField {
  return {
    key: field.key,
    name: field.key,
    label: field.label,
    type: field.type,
    description: field.description,
    required: field.required,
    isList: field.isList,
    path: field.key,
    relation: field.refSchemaId ? { key: field.key, targetKey: field.refSchemaId } : null,
    sortOrder: field.sortOrder,
  };
}

function documentSchemaToCatalogEntry(schema: {
  id: string;
  key: string;
  name: string;
  label: string;
  description: string | null;
  version: number;
  fields?: Parameters<typeof documentFieldToCatalogField>[0][];
}): EntityCatalogEntry {
  return {
    id: schema.id,
    key: schema.key,
    name: schema.key,
    label: schema.label,
    description: schema.description,
    origin: "user",
    backend: "object",
    version: schema.version,
    ...(schema.fields ? { fields: schema.fields.map(documentFieldToCatalogField) } : {}),
  };
}

export async function list(
  filter: ListEntityCatalogFilter,
  scope: EntityScope,
): Promise<ListResult<EntityCatalogEntry>> {
  const { key, name, includeFields = true, limit = 50, offset = 0 } = filter;
  const where: Prisma.ObjectSchemaWhereInput = {
    workspaceId: scope.workspaceId,
    siteId: scope.siteId,
    source: "DOCUMENT" as const,
    isDeleted: false,
    ...(key ? { key } : {}),
    ...(name ? { label: { contains: name, mode: "insensitive" as const } } : {}),
  };

  const schemas = await prisma.objectSchema.findMany({
    where,
    include: catalogInclude(includeFields),
    orderBy: { label: "asc" },
  });

  const systemEntries = systemEntityCatalogEntries(includeFields).filter((entry) => {
    if (key && entry.key !== key) return false;
    if (name && !entry.name.toLowerCase().includes(name.toLowerCase())) return false;
    return true;
  });

  const entries = [...systemEntries, ...schemas.map(documentSchemaToCatalogEntry)];
  const pagedEntries =
    Number(limit) > 0 ? entries.slice(Number(offset), Number(offset) + Number(limit)) : entries.slice(Number(offset));

  return { data: pagedEntries, total: entries.length, limit: Number(limit), offset: Number(offset) };
}

export async function get(
  input: GetEntityCatalogInput,
  scope: EntityScope,
): Promise<ServiceResult<EntityCatalogEntry> | null> {
  if (!input.id && !input.key) return errorResult("CATALOG_LOOKUP_REQUIRED", "Catalog id or key is required");

  if (input.key) {
    const systemEntry = systemEntityCatalogEntryByKey(input.key, input.includeFields ?? true);
    if (systemEntry) return { data: systemEntry };
  }

  const schema = await prisma.objectSchema.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      source: "DOCUMENT",
      isDeleted: false,
      ...(input.id ? { id: input.id } : { key: input.key }),
    },
    include: catalogInclude(input.includeFields ?? true),
  });
  return schema ? { data: documentSchemaToCatalogEntry(schema) } : null;
}
