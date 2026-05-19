// Driver service - public API
// Re-exports all driver-related functionality

export * as crud from "./crud.js";
export * as registry from "./registry.js";

// Re-export commonly used functions at top level
export { list, getById, getSchemas, exists } from "./crud.js";
export { driverRegistry } from "./registry.js";
export type { DriverManifest, DriverInfo } from "./registry.js";
