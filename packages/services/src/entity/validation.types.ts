import type { ObjectFieldType } from "@rw/db";

export interface FieldDefinition {
  id: string;
  name: string;
  key?: string;
  type: ObjectFieldType;
  refSchemaId: string | null;
  isList: boolean;
  required: boolean;
  config: unknown;
  isDeleted?: boolean;
}

export interface FieldConfigInput {
  type: ObjectFieldType;
  refSchemaId?: string | null;
  config?: Record<string, unknown> | null;
}

export interface NormalizedFieldConfig {
  config: Record<string, unknown> | null;
  refSchemaId: string | null;
}

export interface InstanceValueValidationResult {
  values: Record<string, unknown>;
  objectInstanceRefs: string[];
  errors: string[];
}
