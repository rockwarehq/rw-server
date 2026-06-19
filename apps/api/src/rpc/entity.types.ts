import { ENTITY_FIELD_TYPES } from "@rw/services/entity/registry";
import { z } from "zod";

const fieldTypeSchema = z.enum(ENTITY_FIELD_TYPES);
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const idInputSchema = z.object({ id: z.uuid() });

export const listInputSchema = z.object({
  name: z.string().optional(),
  key: z.string().optional(),
  label: z.string().optional(),
  limit: z.number().int().min(0).default(50),
  offset: z.number().int().min(0).default(0),
});

export const modelCreateInputSchema = z.object({
  key: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  displayFieldKey: z.string().min(1).nullable().optional(),
}).refine((input) => Boolean(input.label || input.name), { message: "label or name is required" });

export const modelUpdateInputSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  displayFieldKey: z.string().min(1).nullable().optional(),
});

export const modelFieldCreateInputSchema = z.object({
  schemaId: z.uuid(),
  key: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: fieldTypeSchema,
  refSchemaId: z.uuid().nullable().optional(),
  isList: z.boolean().optional(),
  required: z.boolean().optional(),
  config: jsonObjectSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
}).refine((input) => Boolean(input.label || input.name), { message: "label or name is required" });

export const modelFieldUpdateInputSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  type: fieldTypeSchema.optional(),
  refSchemaId: z.uuid().nullable().optional(),
  isList: z.boolean().optional(),
  required: z.boolean().optional(),
  config: jsonObjectSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export const modelFieldReorderInputSchema = z.object({
  schemaId: z.uuid(),
  fieldIds: z.array(z.uuid()),
});

export const instanceCreateInputSchema = z.object({
  schemaId: z.uuid(),
  name: z.string().min(1).optional(),
  values: jsonObjectSchema.optional(),
});

export const instanceListInputSchema = listInputSchema.extend({
  key: z.string().min(1).optional(),
  schemaId: z.uuid().optional(),
});

export const instanceUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  values: jsonObjectSchema.optional(),
});

export const catalogListInputSchema = listInputSchema.extend({
  key: z.string().min(1).optional(),
  includeFields: z.boolean().default(true),
});

export const catalogGetInputSchema = z
  .object({
    id: z.uuid().optional(),
    key: z.string().min(1).optional(),
    includeFields: z.boolean().default(true),
  })
  .refine((input) => Boolean(input.id || input.key), { message: "id or key is required" });

export type AuthContext = { iam: { id: string; workspaceId?: string | null; siteId?: string | null } };
