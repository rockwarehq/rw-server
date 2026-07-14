import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

import type {
  CreateObjectInstanceInput,
  ListObjectInstancesFilter,
  UpdateObjectInstanceInput,
} from "./instances.types.js";
import { SYSTEM_ENTITY_KEYS } from "./registry.js";
import { publishEntityEvent } from "./events.js";
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
      deletedAt: null,
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
          siteId: station.siteId,
          workcenterId: station.workcenterId,
          currentJobId: station.currentJobId,
          createdAt: station.createdAt,
          updatedAt: station.updatedAt,
          deletedAt: station.deletedAt,
          archivedAt: station.archivedAt,
        }),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Job) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name ? { currentVersion: { is: { name: { contains: name, mode: "insensitive" as const } } } } : {}),
    };
    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: { currentVersion: true },
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.job.count({ where }),
    ]);
    return {
      data: jobs.map((job) =>
        systemInstance(
          key,
          { id: job.id, name: job.currentVersion?.name ?? job.id },
          {
            id: job.id,
            name: job.currentVersion?.name ?? null,
            description: job.currentVersion?.description ?? null,
            standardCycle: job.currentVersion?.standardCycle != null ? Number(job.currentVersion.standardCycle) : null,
            standardCycleUnit: job.currentVersion?.standardCycleUnit ?? null,
            productsPerCycle: job.currentVersion?.productsPerCycle ?? null,
            siteId: job.siteId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            deletedAt: job.deletedAt,
            archivedAt: job.archivedAt,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Product) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name
        ? {
            OR: [
              { currentVersion: { is: { name: { contains: name, mode: "insensitive" as const } } } },
              { currentVersion: { is: { sku: { contains: name, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    };
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { currentVersion: true },
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.product.count({ where }),
    ]);
    return {
      data: products.map((product) =>
        systemInstance(
          key,
          { id: product.id, name: product.currentVersion?.name ?? product.currentVersion?.sku ?? product.id },
          {
            id: product.id,
            sku: product.currentVersion?.sku ?? null,
            name: product.currentVersion?.name ?? null,
            description: product.currentVersion?.description ?? null,
            externalSku: product.currentVersion?.externalSku ?? null,
            weight: product.currentVersion?.weight != null ? Number(product.currentVersion.weight) : null,
            weightUnits: product.currentVersion?.weightUnits ?? null,
            siteId: product.siteId,
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
            deletedAt: product.deletedAt,
            archivedAt: product.archivedAt,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Material) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name
        ? {
            OR: [
              { currentVersion: { is: { name: { contains: name, mode: "insensitive" as const } } } },
              { currentVersion: { is: { materialNumber: { contains: name, mode: "insensitive" as const } } } },
              { currentVersion: { is: { shortCode: { contains: name, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    };
    const [materials, total] = await Promise.all([
      prisma.material.findMany({
        where,
        include: { currentVersion: true },
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.material.count({ where }),
    ]);
    return {
      data: materials.map((material) =>
        systemInstance(
          key,
          {
            id: material.id,
            name: material.currentVersion?.name ?? material.currentVersion?.materialNumber ?? material.id,
          },
          {
            id: material.id,
            materialNumber: material.currentVersion?.materialNumber ?? null,
            shortCode: material.currentVersion?.shortCode ?? null,
            name: material.currentVersion?.name ?? null,
            classification: material.currentVersion?.classification ?? null,
            description: material.currentVersion?.description ?? null,
            externalNumber: material.currentVersion?.externalNumber ?? null,
            weightUnits: material.currentVersion?.weightUnits ?? null,
            siteId: material.siteId,
            createdAt: material.createdAt,
            updatedAt: material.updatedAt,
            deletedAt: material.deletedAt,
            archivedAt: material.archivedAt,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Tool) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name ? { currentVersion: { is: { name: { contains: name, mode: "insensitive" as const } } } } : {}),
    };
    const [tools, total] = await Promise.all([
      prisma.tool.findMany({
        where,
        include: { currentVersion: true },
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.tool.count({ where }),
    ]);
    return {
      data: tools.map((tool) =>
        systemInstance(
          key,
          { id: tool.id, name: tool.currentVersion?.name ?? tool.id },
          {
            id: tool.id,
            name: tool.currentVersion?.name ?? null,
            description: tool.currentVersion?.description ?? null,
            pmLimit: tool.currentVersion?.pmLimit ?? null,
            pmWarn: tool.currentVersion?.pmWarn ?? null,
            cavityCount: tool.currentVersion?.cavityCount ?? null,
            pmCount: tool.pmCount,
            lifeCount: tool.lifeCount,
            siteId: tool.siteId,
            createdAt: tool.createdAt,
            updatedAt: tool.updatedAt,
            deletedAt: tool.deletedAt,
            archivedAt: tool.archivedAt,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Customer) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [customers, total] = await Promise.all([
      prisma.customer.findMany({ where, ...pagination }),
      prisma.customer.count({ where }),
    ]);
    return {
      data: customers.map((customer) =>
        systemInstance(key, customer, {
          id: customer.id,
          name: customer.name,
          siteId: customer.siteId,
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt,
          deletedAt: customer.deletedAt,
        }),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Order) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name ? { orderNumber: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { orderNumber: "asc" },
      }),
      prisma.order.count({ where }),
    ]);
    return {
      data: orders.map((order) =>
        systemInstance(
          key,
          { id: order.id, name: order.orderNumber },
          {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            previousStatus: order.previousStatus,
            sequence: order.sequence,
            priority: order.priority,
            defaultTargetQuantity: order.defaultTargetQuantity,
            startDate: order.startDate,
            dueDate: order.dueDate,
            siteId: order.siteId,
            customerId: order.customerId,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            deletedAt: order.deletedAt,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.WorkOrder) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name ? { orderNumber: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [orders, total] = await Promise.all([
      prisma.workOrder.findMany({
        where,
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { orderNumber: "asc" },
      }),
      prisma.workOrder.count({ where }),
    ]);
    return {
      data: orders.map((order) =>
        systemInstance(
          key,
          { id: order.id, name: order.orderNumber },
          {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            targetQuantity: order.targetQuantity,
            completedQuantity: order.completedQuantity,
            scrapQuantity: order.scrapQuantity,
            dueDate: order.dueDate,
            priority: order.priority,
            siteId: order.siteId,
            jobId: order.jobId,
            productId: order.productId,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            deletedAt: order.deletedAt,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.Employee) {
    const where = {
      workspaceId: scope.workspaceId,
      siteAccess: { some: { siteId: scope.siteId, status: "ACTIVE" as const } },
      ...(name
        ? {
            OR: [
              { version: { firstName: { contains: name, mode: "insensitive" as const } } },
              { version: { lastName: { contains: name, mode: "insensitive" as const } } },
              { version: { employeeNumber: { contains: name, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };
    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: { version: true },
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.employee.count({ where }),
    ]);
    return {
      data: employees.map((employee) =>
        systemInstance(
          key,
          {
            id: employee.id,
            name: [employee.version?.firstName, employee.version?.lastName].filter(Boolean).join(" ") || employee.id,
          },
          {
            id: employee.id,
            status: employee.status,
            firstName: employee.version?.firstName ?? null,
            lastName: employee.version?.lastName ?? null,
            employeeNumber: employee.version?.employeeNumber ?? null,
            createdAt: employee.createdAt,
            updatedAt: employee.updatedAt,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.ShiftInstance) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      ...(name ? { shiftName: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [instances, total] = await Promise.all([
      prisma.shiftInstance.findMany({
        where,
        ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
        skip: Number(offset),
        orderBy: { startTime: "asc" },
      }),
      prisma.shiftInstance.count({ where }),
    ]);
    return {
      data: instances.map((instance) =>
        systemInstance(
          key,
          { id: instance.id, name: instance.shiftName },
          {
            id: instance.id,
            shiftName: instance.shiftName,
            businessDate: instance.businessDate,
            startTime: instance.startTime,
            endTime: instance.endTime,
            siteId: instance.siteId,
            workcenterId: instance.workCenterId,
          },
        ),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.StatusReason) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      archivedAt: null,
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [reasons, total] = await Promise.all([
      prisma.statusReason.findMany({ where, ...pagination }),
      prisma.statusReason.count({ where }),
    ]);
    return {
      data: reasons.map((reason) =>
        systemInstance(key, reason, {
          id: reason.id,
          name: reason.name,
          isPlannedDown: reason.isPlannedDown,
          siteId: reason.siteId,
          categoryId: reason.categoryId,
          createdAt: reason.createdAt,
          updatedAt: reason.updatedAt,
          archivedAt: reason.archivedAt,
        }),
      ),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  if (key === SYSTEM_ENTITY_KEYS.StatusCategory) {
    const where = {
      siteId: scope.siteId,
      site: { workspaceId: scope.workspaceId },
      deletedAt: null,
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    };
    const [categories, total] = await Promise.all([
      prisma.statusCategory.findMany({ where, ...pagination }),
      prisma.statusCategory.count({ where }),
    ]);
    return {
      data: categories.map((category) =>
        systemInstance(key, category, {
          id: category.id,
          name: category.name,
          siteId: category.siteId,
          createdAt: category.createdAt,
          updatedAt: category.updatedAt,
          deletedAt: category.deletedAt,
          archivedAt: category.archivedAt,
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
  publishEntityEvent({
    action: "created",
    entityKey: instance.schema.key,
    entityId: instance.id,
    siteId: scope.siteId,
    workspaceId: scope.workspaceId,
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
  publishEntityEvent({
    action: "updated",
    entityKey: instance.schema.key,
    entityId: instance.id,
    siteId: scope.siteId,
    workspaceId: scope.workspaceId,
    changedFields: input.values ? Object.keys(input.values) : undefined,
  });
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
  publishEntityEvent({
    action: "deleted",
    entityKey: current.schema.key,
    entityId: current.id,
    siteId: scope.siteId,
    workspaceId: scope.workspaceId,
  });
  return { data: { success: true } };
}
