import type {
  EntityCatalogEntry,
  EntityCatalogField,
  SystemEntityFieldSpec,
  SystemEntitySpec,
} from "./registry.types.js";

export const ENTITY_FIELD_TYPES = [
  "TEXT",
  "NUMBER",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "SELECT",
  "JSON",
  "OBJECT",
] as const;

export type EntityFieldType = (typeof ENTITY_FIELD_TYPES)[number];

export const SYSTEM_ENTITY_NAMESPACE = "imm";

export const SYSTEM_ENTITY_KEYS = {
  Site: `${SYSTEM_ENTITY_NAMESPACE}.site`,
  Workcenter: `${SYSTEM_ENTITY_NAMESPACE}.workcenter`,
  Station: `${SYSTEM_ENTITY_NAMESPACE}.station`,
} as const;

export const SYSTEM_ENTITY_REGISTRY: readonly SystemEntitySpec[] = [
  {
    key: SYSTEM_ENTITY_KEYS.Site,
    model: "Site",
    name: "Site",
    label: "Site",
    description: "Platform-defined site record.",
    fields: [
      { name: "id", type: "TEXT", sortOrder: 0 },
      { name: "name", type: "TEXT", required: true, sortOrder: 10 },
      { name: "description", type: "TEXT", sortOrder: 20 },
      { name: "timezone", type: "TEXT", sortOrder: 30 },
      { name: "attrs", type: "JSON", sortOrder: 40 },
      {
        name: "workcenters",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Workcenter,
        relation: "workcenters",
        isList: true,
        sortOrder: 100,
      },
      {
        name: "stations",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Station,
        relation: "stations",
        isList: true,
        sortOrder: 110,
      },
    ],
  },
  {
    key: SYSTEM_ENTITY_KEYS.Workcenter,
    model: "Workcenter",
    name: "Workcenter",
    label: "Workcenter",
    description: "Platform-defined workcenter record.",
    fields: [
      { name: "id", type: "TEXT", sortOrder: 0 },
      { name: "name", type: "TEXT", required: true, sortOrder: 10 },
      { name: "description", type: "TEXT", sortOrder: 20 },
      { name: "attrs", type: "JSON", sortOrder: 30 },
      {
        name: "site",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Site,
        relation: "site",
        sortOrder: 90,
      },
      {
        name: "parent",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Workcenter,
        relation: "parent",
        sortOrder: 100,
      },
      {
        name: "children",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Workcenter,
        relation: "children",
        isList: true,
        sortOrder: 110,
      },
      {
        name: "stations",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Station,
        relation: "stations",
        isList: true,
        sortOrder: 120,
      },
    ],
  },
  {
    key: SYSTEM_ENTITY_KEYS.Station,
    model: "Station",
    name: "Station",
    label: "Station",
    description: "Platform-defined station record.",
    fields: [
      { name: "id", type: "TEXT", sortOrder: 0 },
      { name: "name", type: "TEXT", required: true, sortOrder: 10 },
      { name: "description", type: "TEXT", sortOrder: 20 },
      { name: "attrs", type: "JSON", sortOrder: 30 },
      {
        name: "site",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Site,
        relation: "site",
        sortOrder: 90,
      },
      {
        name: "workcenter",
        type: "OBJECT",
        targetKey: SYSTEM_ENTITY_KEYS.Workcenter,
        relation: "workcenter",
        sortOrder: 100,
      },
    ],
  },
];

export function systemEntityCatalogEntries(includeFields = true): EntityCatalogEntry[] {
  return SYSTEM_ENTITY_REGISTRY.map((entity) => ({
    id: entity.key,
    key: entity.key,
    name: entity.name,
    label: entity.label,
    description: entity.description,
    origin: "system",
    backend: "record",
    model: entity.model,
    ...(includeFields ? { fields: entity.fields.map(systemFieldToCatalogField) } : {}),
  }));
}

export function systemEntityCatalogEntryByKey(key: string, includeFields = true): EntityCatalogEntry | null {
  return systemEntityCatalogEntries(includeFields).find((entry) => entry.key === key) ?? null;
}

export function systemRelationTargets(): Map<string, Map<string, string>> {
  const targetsByModel = new Map<string, Map<string, string>>();
  const modelByKey = new Map(SYSTEM_ENTITY_REGISTRY.map((entity) => [entity.key, entity.model]));

  for (const entity of SYSTEM_ENTITY_REGISTRY) {
    const targets = new Map<string, string>();
    for (const field of entity.fields) {
      if (!field.relation || !field.targetKey) continue;
      const targetModel = modelByKey.get(field.targetKey);
      if (targetModel) targets.set(field.relation, targetModel);
    }
    targetsByModel.set(entity.model, targets);
  }

  return targetsByModel;
}

function systemFieldToCatalogField(field: SystemEntityFieldSpec): EntityCatalogField {
  return {
    key: field.name,
    name: field.name,
    label: field.label ?? field.name,
    type: field.type,
    description: field.description ?? null,
    required: field.required ?? false,
    isList: field.isList ?? false,
    path: field.path ?? field.name,
    relation: field.relation && field.targetKey ? { key: field.relation, targetKey: field.targetKey } : null,
    sortOrder: field.sortOrder,
  };
}
