export interface ListEntityCatalogFilter {
  key?: string;
  name?: string;
  includeFields?: boolean;
  limit?: number;
  offset?: number;
}

export interface GetEntityCatalogInput {
  id?: string;
  key?: string;
  includeFields?: boolean;
}
