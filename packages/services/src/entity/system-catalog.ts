import prisma from "@rw/db";
import type { ObjectFieldType, Prisma } from "@rw/db";

export const SYSTEM_OBJECT_SCHEMA_KEYS = {
  Site: "system.site",
  Workcenter: "system.workcenter",
  Station: "system.station",
} as const;

type SystemRecordModel = keyof typeof SYSTEM_OBJECT_SCHEMA_KEYS;
type Binding = Prisma.InputJsonObject;

interface SystemFieldSpec {
  name: string;
  type: ObjectFieldType;
  description?: string;
  refKey?: string;
  isList?: boolean;
  required?: boolean;
  sortOrder: number;
  binding: Binding;
}

interface SystemSchemaSpec {
  key: string;
  model: SystemRecordModel;
  name: string;
  description: string;
  fields: readonly SystemFieldSpec[];
}

const recordBinding = (path: string): Binding => ({ kind: "record", path });
const relationBinding = (relation: string): Binding => ({ kind: "relation", relation });

const SYSTEM_SCHEMAS: readonly SystemSchemaSpec[] = [
  {
    key: SYSTEM_OBJECT_SCHEMA_KEYS.Site,
    model: "Site",
    name: "Site",
    description: "Platform-defined site record.",
    fields: [
      { name: "id", type: "TEXT", sortOrder: 0, binding: recordBinding("id") },
      { name: "name", type: "TEXT", required: true, sortOrder: 10, binding: recordBinding("name") },
      { name: "description", type: "TEXT", sortOrder: 20, binding: recordBinding("description") },
      { name: "timezone", type: "TEXT", sortOrder: 30, binding: recordBinding("timezone") },
      { name: "attrs", type: "JSON", sortOrder: 40, binding: recordBinding("attrs") },
      {
        name: "workcenters",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Workcenter,
        isList: true,
        sortOrder: 100,
        binding: relationBinding("workcenters"),
      },
      {
        name: "stations",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Station,
        isList: true,
        sortOrder: 110,
        binding: relationBinding("stations"),
      },
    ],
  },
  {
    key: SYSTEM_OBJECT_SCHEMA_KEYS.Workcenter,
    model: "Workcenter",
    name: "Workcenter",
    description: "Platform-defined workcenter record.",
    fields: [
      { name: "id", type: "TEXT", sortOrder: 0, binding: recordBinding("id") },
      { name: "name", type: "TEXT", required: true, sortOrder: 10, binding: recordBinding("name") },
      { name: "description", type: "TEXT", sortOrder: 20, binding: recordBinding("description") },
      { name: "attrs", type: "JSON", sortOrder: 30, binding: recordBinding("attrs") },
      {
        name: "site",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Site,
        sortOrder: 90,
        binding: relationBinding("site"),
      },
      {
        name: "parent",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Workcenter,
        sortOrder: 100,
        binding: relationBinding("parent"),
      },
      {
        name: "children",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Workcenter,
        isList: true,
        sortOrder: 110,
        binding: relationBinding("children"),
      },
      {
        name: "stations",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Station,
        isList: true,
        sortOrder: 120,
        binding: relationBinding("stations"),
      },
    ],
  },
  {
    key: SYSTEM_OBJECT_SCHEMA_KEYS.Station,
    model: "Station",
    name: "Station",
    description: "Platform-defined station record.",
    fields: [
      { name: "id", type: "TEXT", sortOrder: 0, binding: recordBinding("id") },
      { name: "name", type: "TEXT", required: true, sortOrder: 10, binding: recordBinding("name") },
      { name: "description", type: "TEXT", sortOrder: 20, binding: recordBinding("description") },
      { name: "attrs", type: "JSON", sortOrder: 30, binding: recordBinding("attrs") },
      {
        name: "site",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Site,
        sortOrder: 90,
        binding: relationBinding("site"),
      },
      {
        name: "workcenter",
        type: "OBJECT",
        refKey: SYSTEM_OBJECT_SCHEMA_KEYS.Workcenter,
        sortOrder: 100,
        binding: relationBinding("workcenter"),
      },
    ],
  },
];

function schemaMeta(spec: SystemSchemaSpec): Prisma.InputJsonValue {
  return {
    record: { model: spec.model },
    catalog: { key: spec.key, label: spec.name },
  };
}

function fieldConfig(field: SystemFieldSpec): Prisma.InputJsonValue {
  return { binding: field.binding } satisfies Prisma.InputJsonObject;
}

export async function seedSystemObjectSchemas(): Promise<void> {
  const schemaIdsByKey = new Map<string, string>();

  for (const spec of SYSTEM_SCHEMAS) {
    const schema = await prisma.objectSchema.upsert({
      where: { key: spec.key },
      create: {
        key: spec.key,
        name: spec.name,
        description: spec.description,
        source: "RECORD",
        meta: schemaMeta(spec),
        isSystem: true,
        workspaceId: null,
      },
      update: {
        name: spec.name,
        description: spec.description,
        source: "RECORD",
        meta: schemaMeta(spec),
        isSystem: true,
        isDeleted: false,
      },
    });
    schemaIdsByKey.set(spec.key, schema.id);
  }

  for (const spec of SYSTEM_SCHEMAS) {
    const schemaId = schemaIdsByKey.get(spec.key);
    if (!schemaId) throw new Error(`System object schema missing after upsert: ${spec.key}`);

    for (const field of spec.fields) {
      const refSchemaId = field.refKey ? schemaIdsByKey.get(field.refKey) : null;
      if (field.refKey && !refSchemaId) throw new Error(`System object schema ref missing: ${field.refKey}`);

      await prisma.objectSchemaField.upsert({
        where: { schemaId_name: { schemaId, name: field.name } },
        create: {
          schemaId,
          name: field.name,
          description: field.description ?? null,
          type: field.type,
          refSchemaId,
          isList: field.isList ?? false,
          required: field.required ?? false,
          sortOrder: field.sortOrder,
          config: fieldConfig(field),
        },
        update: {
          description: field.description ?? null,
          type: field.type,
          refSchemaId,
          isList: field.isList ?? false,
          required: field.required ?? false,
          sortOrder: field.sortOrder,
          config: fieldConfig(field),
          isDeleted: false,
        },
      });
    }
  }
}
