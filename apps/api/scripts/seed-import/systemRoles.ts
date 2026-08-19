// Single source of truth for system role bundles lives in src/. This module
// previously carried a drifted copy of SYSTEM_ROLE_SPECS (missing the entity
// and graph permissions); it now re-exports the canonical definitions.
export { SYSTEM_ROLE_SPECS, seedSystemRoles } from "../../src/seed-system-roles.js";
