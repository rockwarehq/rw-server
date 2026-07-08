import { coreLivestoreCatalog } from "./core.js";
import { immLivestoreCatalog } from "./imm.js";
import { createLivestoreCatalog } from "./registry.js";

// Single facade over every Livestore-facing catalog: hook event schemas,
// graph type namespaces, definition/event subjects, and metric subject helpers.
export const LIVESTORE_CATALOG = createLivestoreCatalog([coreLivestoreCatalog, immLivestoreCatalog]);

export { coreLivestoreCatalog } from "./core.js";
export { immLivestoreCatalog } from "./imm.js";
export * from "./registry.js";
export * from "./events.js";
export * from "./graph-types.js";
export * from "./hook-conditions.js";
export * from "./definitions.js";
export * from "./subjects.js";
