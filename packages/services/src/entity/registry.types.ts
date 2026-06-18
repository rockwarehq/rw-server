import type { EntityFieldType } from "./registry.js";

export type EntityCatalogOrigin = "system" | "user";
export type EntityCatalogBackend = "record" | "object";

export interface EntityCatalogField {
  key: string;
  name: string;
  label: string;
  type: EntityFieldType;
  description?: string | null;
  required: boolean;
  isList: boolean;
  path: string;
  relation?: {
    key: string;
    targetKey: string;
  } | null;
  sortOrder: number;
}

export interface EntityCatalogEntry {
  id: string;
  key: string;
  name: string;
  label: string;
  description?: string | null;
  origin: EntityCatalogOrigin;
  backend: EntityCatalogBackend;
  model?: string;
  version?: number;
  fields?: EntityCatalogField[];
}

export interface SystemEntityFieldSpec {
  name: string;
  label?: string;
  type: EntityFieldType;
  description?: string;
  targetKey?: string;
  relation?: string;
  isList?: boolean;
  required?: boolean;
  sortOrder: number;
  path?: string;
}

export interface SystemEntitySpec {
  key: string;
  model: string;
  name: string;
  label: string;
  description: string;
  fields: readonly SystemEntityFieldSpec[];
}
