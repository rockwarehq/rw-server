export type ServiceResult<T> = { data: T } | { error: string; code: string };

export interface GraphScope {
  workspaceId: string;
  siteId: string;
}

export interface ListResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export function errorResult(code: string, error: string): { error: string; code: string } {
  return { error, code };
}

export interface GraphResolverInput {
  resolverType?: string;
  resolver?: Record<string, unknown>;
  schemaFieldId?: string | null;
}
