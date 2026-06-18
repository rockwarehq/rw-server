export type ServiceResult<T> = { data: T } | { error: string; code: string };

export interface ListResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface EntityScope {
  workspaceId: string;
  siteId: string;
}

export function errorResult(code: string, error: string): { error: string; code: string } {
  return { error, code };
}

export function normalizeEntityKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
