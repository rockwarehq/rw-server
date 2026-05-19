import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";

// Deserialization options to map JSON schema types to TypeScript types.
// This allows Prisma's return types to be compatible with JSON schema response types.
export type SerializerSchemaOptions = {
  deserialize: [
    // Map date-time strings to Date objects
    {
      pattern: { type: "string"; format: "date-time" };
      output: Date;
    },
    // Map nullable date-time strings to Date | null
    // Use JSON Schema union types (not OpenAPI `nullable`) for this.
    {
      pattern: { type: ["string", "null"]; format: "date-time" };
      output: Date | null;
    },
    // Map JSON object fields (additionalProperties: true) to unknown
    // This matches Prisma's JSON field return type
    {
      pattern: { type: "object"; additionalProperties: true };
      output: unknown;
    },
    // Map nullable JSON object fields to unknown | null
    {
      pattern: { type: ["object", "null"]; additionalProperties: true };
      output: unknown | null;
    },
  ];
};

export type FastifyTypedInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  JsonSchemaToTsProvider<{ SerializerSchemaOptions: SerializerSchemaOptions }>
>;
