// Workspace service - public API
// Re-exports all workspace-related functionality

export * as crud from "./crud.js";
export * as members from "./members.js";

// Re-export commonly used functions at top level for convenience
export { getById, update, exists, listForUser, type UpdateWorkspaceInput } from "./crud.js";

export {
  removeMember,
  removeSiteAccess,
  updateAccess,
  listMembers,
  getUserAccess,
  countMembers,
  type MemberAccessSummary,
  type MemberBucketAccess,
  type UpdateAccessInput,
  type UpdateAccessResult,
} from "./members.js";
