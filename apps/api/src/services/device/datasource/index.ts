// Datasource service - public API
// Re-exports all datasource-related functionality

export * as crud from "./crud.js";
export * as points from "./points.js";
export * as groups from "./groups.js";

// Re-export commonly used functions at top level for convenience
export {
  create,
  list,
  getById,
  update,
  remove,
  exists,
  assign,
  getWithDriver,
  publish,
  unpublish,
  type CreateDatasourceInput,
  type UpdateDatasourceInput,
  type ListDatasourcesFilter,
} from "./crud.js";
export { bulkCreate as bulkCreatePoints } from "./points.js";
