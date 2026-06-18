import type { ObjectFieldType } from "@rw/db";

export interface CreateObjectModelInput {
  key?: string;
  label?: string;
  name?: string;
  description?: string;
  displayFieldKey?: string | null;
}

export interface UpdateObjectModelInput {
  key?: string;
  label?: string;
  description?: string | null;
  displayFieldKey?: string | null;
}

export interface ListObjectModelsFilter {
  key?: string;
  label?: string;
  limit?: number;
  offset?: number;
}

export interface CreateObjectModelFieldInput {
  schemaId: string;
  key?: string;
  label?: string;
  name?: string;
  description?: string;
  type: ObjectFieldType;
  refSchemaId?: string | null;
  isList?: boolean;
  required?: boolean;
  config?: Record<string, unknown> | null;
  sortOrder?: number;
}

export interface UpdateObjectModelFieldInput {
  key?: string;
  label?: string;
  description?: string | null;
  type?: ObjectFieldType;
  refSchemaId?: string | null;
  isList?: boolean;
  required?: boolean;
  config?: Record<string, unknown> | null;
  sortOrder?: number;
}
