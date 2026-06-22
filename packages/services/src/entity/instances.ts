import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import type {
  CreateObjectInstanceInput,
  ListObjectInstancesFilter,
  UpdateObjectInstanceInput,
} from "./instances.types.js";
import { SYSTEM_ENTITY_KEYS } from "./registry.js";
import { errorResult, type EntityScope, type ListResult, type ServiceResult } from "./types.js";
import { asValueRecord, validateInstanceValues } from "./validation.js";

const instanceInclude = {
  schema: {
    select: {
      id: true,
      key: true,
      label: true,
      name: true,
      source: true,
      workspaceId: true,
      siteId: true,
      version: true,
    },
  },
};

async function getSchemaWithFields(schemaId: string, scope: EntityScope) {
  const schema = await prisma.objectSchema.findUnique({
    where: { id: schemaId },
    include: { fields: { where: { isDeleted: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
  });
  if (!schema) return errorResult("SCHEMA_NOT_FOUND", "Schema not found");
  if (schema.workspaceId !== scope.workspaceId || schema.siteId !== scope.siteId)
    return errorResult("SITE_MISMATCH", "Schema does not belong to this site");
  if (schema.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  if (schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas can create documents");
  return { data: schema };
}

async function validateObjectRefs(refs: readonly string[], scope: EntityScope) {
  if (refs.length === 0) return null;
  const count = await prisma.objectInstance.count({
    where: {
      id: { in: [...refs] },
      siteId: scope.siteId,
      isDeleted: false,
      schema: { workspaceId: scope.workspaceId, siteId: scope.siteId, source: "DOCUMENT", isDeleted: false },
    },
  });
  return count === refs.length
    ? null
    : errorResult("OBJECT_REF_NOT_FOUND", "One or more object references were not found");
}

function systemSchema(key: string) {
  return { id: key, key, source: "SYSTEM" };
}

function systemInstance(key: string, record: { id: string; name: string }, values: Record<string, unknown>) {
  return {
    id: record.id,
    name: record.name,
    key,
    values,
    schema: systemSchema(key),
  };
}

async function listSystemInstances(
  key: string,
  filter: ListObjectInstancesFilter,
  scope: EntityScope,
): Promise<ListResult<unknown> | ServiceResult<never>> {
  const { name, limit = 50, offset = 0 } = filter;
  const pagination = {
    ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
    skip: Number(offset),
    orderBy: { name: "asc" as const },
  };

  if (key === SYSTEM_ENTITY_KEYS.Site) {
    const where = {
      id: scope.siteId,
      workspaceId: scope.workspaceId,
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [sites, total] = await Promise.all([
      prisma.site.findMany({ where, ...pagination }),
      prisma.site.count({ where }),
    ]);
    return {
      data: sites.map((site) =>
        systemInstance(key, site, {
          id: site.id,
          name: site.name,
          description: site.description,
          timezone: site.timezone,
          attrs: site.attrs,
        }),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Workcenter) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [workcenters, total] = await Promise.all([
      prisma.workcenter.findMany({ where, ...pagination }),
      prisma.workcenter.count({ where }),
    ]);
    return {
      data: workcenters.map((workcenter) =>
        systemInstance(key, workcenter, {
          id: workcenter.id,
          name: workcenter.name,
          description: workcenter.description,
          attrs: workcenter.attrs,
          siteId: workcenter.siteId,
          parentId: workcenter.parentId,
        }),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Station) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [stations, total] = await Promise.all([
      prisma.station.findMany({ where, ...pagination }),
      prisma.station.count({ where }),
    ]);
    return {
      data: stations.map((station) =>
        systemInstance(key, station, {
          id: station.id,
          name: station.name,
          description: station.description,
          attrs: station.attrs,
          siteId: station.siteId,
          workcenterId: station.workcenterId,
        }),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  return errorResult("ENTITY_NOT_FOUND", "System entity not found");
}

export async function create(input: CreateObjectInstanceInput, scope: EntityScope): Promise<ServiceResult<unknown>> {
  const schemaResult = await getSchemaWithFields(input.schemaId, scope);
  if ("error" in schemaResult) return schemaResult;

  const validation = validateInstanceValues(schemaResult.data.fields, input.values ?? {});
  if (validation.errors.length > 0) return errorResult("INVALID_VALUES", validation.errors.join("; "));
  const refError = await validateObjectRefs(validation.objectInstanceRefs, scope);
  if (refError) return refError;

  const instance = await prisma.objectInstance.create({
    data: {
      schemaId: input.schemaId,
      siteId: scope.siteId,
      name: schemaResult.data.label,
      values: validation.values as Prisma.InputJsonValue,
    },
    include: instanceInclude,
  });
  return { data: instance };
}

export async function list(
  filter: ListObjectInstancesFilter,
  scope: EntityScope,
): Promise<ListResult<unknown> | ServiceResult<never>> {
  const { key, schemaId, name, limit = 50, offset = 0 } = filter;
  if (key && schemaId) {
    return errorResult("ENTITY_INSTANCE_FILTER_INVALID", "Use either key or schemaId, not both");
  }
  if (key) return listSystemInstances(key, filter, scope);

  const where = {
    isDeleted: false,
    siteId: scope.siteId,
    schema: { workspaceId: scope.workspaceId, siteId: scope.siteId, source: "DOCUMENT" as const, isDeleted: false },
    ...(schemaId ? { schemaId } : {}),
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
  };

  const [instances, total] = await Promise.all([
    prisma.objectInstance.findMany({
      where,
      include: instanceInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.objectInstance.count({ where }),
  ]);

  return { data: instances, total, limit: Number(limit), offset: Number(offset) };
}

export async function getById(id: string, scope: EntityScope): Promise<ServiceResult<unknown> | null> {
  const instance = await prisma.objectInstance.findUnique({ where: { id }, include: instanceInclude });
  if (!instance) return null;
  if (
    instance.schema.workspaceId !== scope.workspaceId ||
    instance.schema.siteId !== scope.siteId ||
    instance.siteId !== scope.siteId
  )
    return errorResult("SITE_MISMATCH", "Instance does not belong to this site");
  if (instance.schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas have documents");
  if (instance.isDeleted) return errorResult("INSTANCE_DELETED", "Instance has been deleted");
  return { data: instance };
}

export async function update(
  id: string,
  input: UpdateObjectInstanceInput,
  scope: EntityScope,
): Promise<ServiceResult<unknown>> {
  const current = await prisma.objectInstance.findUnique({
    where: { id },
    include: { schema: { include: { fields: { where: { isDeleted: false } } } } },
  });
  if (!current) return errorResult("INSTANCE_NOT_FOUND", "Instance not found");
  if (
    current.schema.workspaceId !== scope.workspaceId ||
    current.schema.siteId !== scope.siteId ||
    current.siteId !== scope.siteId
  )
    return errorResult("SITE_MISMATCH", "Instance does not belong to this site");
  if (current.schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas have documents");
  if (current.schema.isDeleted) return errorResult("SCHEMA_DELETED", "Schema has been deleted");
  if (current.isDeleted) return errorResult("INSTANCE_DELETED", "Instance has been deleted");

  const updateData: Record<string, unknown> = {};
  if (input.values !== undefined) {
    const mergedValues = { ...asValueRecord(current.values), ...input.values };
    const validation = validateInstanceValues(current.schema.fields, mergedValues);
    if (validation.errors.length > 0) return errorResult("INVALID_VALUES", validation.errors.join("; "));
    const refError = await validateObjectRefs(validation.objectInstanceRefs, scope);
    if (refError) return refError;
    updateData.values = validation.values;
  }

  const instance = await prisma.objectInstance.update({ where: { id }, data: updateData, include: instanceInclude });
  return { data: instance };
}

export async function remove(id: string, scope: EntityScope): Promise<ServiceResult<{ success: true }>> {
  const current = await prisma.objectInstance.findUnique({ where: { id }, include: { schema: true } });
  if (!current) return errorResult("INSTANCE_NOT_FOUND", "Instance not found");
  if (
    current.schema.workspaceId !== scope.workspaceId ||
    current.schema.siteId !== scope.siteId ||
    current.siteId !== scope.siteId
  )
    return errorResult("SITE_MISMATCH", "Instance does not belong to this site");
  if (current.schema.source !== "DOCUMENT")
    return errorResult("SCHEMA_SOURCE_INVALID", "Only DOCUMENT schemas have documents");
  if (current.isDeleted) return { data: { success: true } };

  await prisma.objectInstance.update({ where: { id }, data: { isDeleted: true } });
  return { data: { success: true } };
}
