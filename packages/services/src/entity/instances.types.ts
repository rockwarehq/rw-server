export interface CreateObjectInstanceInput {
  schemaId: string;
  values?: Record<string, unknown>;
}

export interface UpdateObjectInstanceInput {
  values?: Record<string, unknown>;
}

export interface ListObjectInstancesFilter {
  key?: string;
  schemaId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}
