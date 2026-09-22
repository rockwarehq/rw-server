// IAM — role-based access control for the User principal tier.
//
// Permissions are `resource:action` strings defined in code (permissions.ts).
// Roles are DB rows owned by a Workspace, carrying an array of those strings.
// A RoleAssignment links a WorkspaceMembership to a Role, optionally narrowed
// to one Site or Workcenter.

export * as roles from "./roles.js";
export * as assignments from "./assignments.js";
export * as workcenterGrants from "./workcenter-grants.js";

export {
  RESOURCES,
  ACTIONS,
  ALL_PERMISSIONS,
  CUSTOMER_PERMISSIONS,
  PERMISSION_DEFINITIONS,
  OWNER_PERMISSION,
  RESERVED_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  hasOwnerPermission,
  isPermission,
  validatePermissions,
  validateCustomRolePermissions,
  expandPermissions,
  mapLegacyCustomPermissions,
  LEGACY_CUSTOM_PERMISSION_CATALOG,
  LEGACY_PERMISSION_MIGRATION_RULES,
  getLegacyPermissionMigrationRequirements,
  getEffectivePermissions,
  hasPermission,
  hasAnyPermission,
  getAccessibleSites,
  getVisibleSites,
  listAccessibleSites,
  loadPermissionSnapshot,
  snapshotEffectivePermissions,
  snapshotHasPermission,
  snapshotAccessibleSites,
  snapshotVisibleSites,
  snapshotWorkcentersWithPermission,
  snapshotAccessibleWorkcenters,
  snapshotVisibleWorkcenters,
  snapshotCanReadReferences,
  BASE_WORKCENTER_ACCESS_KEY,
  type BaseWorkcenterAccess,
  type PermissionSnapshot,
  type PermissionRoleScope,
  type PermissionMigrationDelta,
  type LegacyPermissionMigrationRule,
  type LegacyPermissionMigrationRequirement,
  type AccessibleWorkcenters,
  type Resource,
  type Action,
  type ReservedPermission,
  type Permission,
  type CustomerPermission,
  type PermissionDefinition,
  type PermissionContext,
  type AccessibleSites,
  type AccessibleSiteRef,
} from "./permissions.js";

export { findSystemRole } from "./roles.js";

export { ScopeMismatchError, SystemUserAssignmentError } from "./assignments.js";

export {
  authorize,
  authorizeList,
  authorizeAccessibleSites,
  authorizeReferenceRead,
  scopeFilter,
  scopeWhere,
  scopeWorkcenterWhere,
  type ScopeRef,
  type SiteGrant,
  type ListScope,
  type PolicyDenial,
} from "./policy.js";
export { resolveSiteRef, type SiteRow } from "./policy-resolvers.js";
