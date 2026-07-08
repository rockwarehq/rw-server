import type { GraphTypeInputValueType, GraphTypeValueType } from "../catalog/graph-types.js";

import * as nodeTypes from "./node-types.js";
import type { GraphScope, ServiceResult } from "./types.js";

// Introspection service layer: read-only views compiled for programmatic
// builders. Everything here reads Postgres/catalog state only — no engine
// involvement.

type JsonSchema = Record<string, unknown>;

function valueTypeToJsonSchema(valueType: GraphTypeValueType | GraphTypeInputValueType, entityKey?: string | null): JsonSchema {
  switch (valueType) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "percent":
      return { type: "number", description: "Ratio expressed as a number (1 = 100%)." };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "object":
    case "json":
      return {};
    case "entityRef":
      return {
        type: "string",
        description: entityKey
          ? `ID of a "${entityKey}" entity instance in the site (see entity.catalog / entity list RPCs).`
          : "ID of an entity instance in the site.",
        ...(entityKey ? { "x-entityKey": entityKey } : {}),
      };
    default:
      return {};
  }
}

export interface GraphTypeNodeSchema {
  typeRef: string;
  source: "integration" | "site";
  label: string;
  description: string | null;
  // JSON Schema for the graph.node.create payload targeting this type.
  nodeCreateSchema: JsonSchema;
  // Properties stamped onto the node when materializeTypeFields is true.
  materializedFields: Array<{
    key: string;
    label: string;
    description: string | null;
    valueType: GraphTypeValueType;
    resolverType: string;
    sampleRateMs: number | null;
  }>;
  // Entity-derived facets computed for the node (queryable via node.query).
  facets: Array<{
    key: string;
    label: string;
    description: string | null;
    valueType: GraphTypeValueType | null;
  }>;
}

// Compile a graph type (integration or site-defined) into a JSON Schema an
// agent can use to construct a valid node.create call. Generated on request
// because site types are user data and change at runtime.
export async function typeNodeSchema(typeRef: string, scope: GraphScope): Promise<ServiceResult<GraphTypeNodeSchema>> {
  const resolved = await nodeTypes.resolve(typeRef, scope);
  if ("error" in resolved) return resolved;
  const type = resolved.data;

  const contextProperties: Record<string, JsonSchema> = {};
  const requiredInputs: string[] = [];
  for (const input of type.inputs) {
    contextProperties[input.key] = {
      ...valueTypeToJsonSchema(input.valueType, input.entityKey),
      ...(input.description ? { description: input.description } : {}),
      title: input.label,
    };
    if (input.required) requiredInputs.push(input.key);
  }

  const nodeCreateSchema: JsonSchema = {
    type: "object",
    description: `Payload for graph.node.create with typeRef "${type.typeRef}".`,
    properties: {
      siteId: { type: "string", format: "uuid" },
      name: { type: "string", minLength: 1, description: "Unique node name within the site." },
      typeRef: { const: type.typeRef },
      typeContext: {
        type: "object",
        description: "Values for the type's declared inputs.",
        properties: contextProperties,
        ...(requiredInputs.length > 0 ? { required: requiredInputs } : {}),
      },
      materializeTypeFields: {
        type: "boolean",
        description: "When true, the type's fields are stamped onto the node as properties at create time.",
      },
    },
    required: ["siteId", "name", "typeRef", ...(requiredInputs.length > 0 ? ["typeContext"] : [])],
  };

  return {
    data: {
      typeRef: type.typeRef,
      source: type.source,
      label: type.label,
      description: type.description ?? null,
      nodeCreateSchema,
      materializedFields: type.fields.map((field) => ({
        key: field.key,
        label: field.label,
        description: field.description ?? null,
        valueType: field.valueType,
        resolverType: field.resolverType,
        sampleRateMs: field.sampleRateMs ?? null,
      })),
      facets: type.facets.map((facet) => ({
        key: facet.key,
        label: facet.label,
        description: facet.description ?? null,
        valueType: facet.valueType ?? null,
      })),
    },
  };
}
