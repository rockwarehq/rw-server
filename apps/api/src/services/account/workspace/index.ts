// Workspace service - public API
// Re-exports all workspace-related functionality

export * as crud from "./crud.js";
export * as members from "./members.js";
export * as defaults from "./defaults.js";

// Re-export commonly used functions at top level for convenience
export {
  create,
  list,
  getById,
  getBySlug,
  update,
  remove,
  exists,
  slugExists,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
} from "./crud.js";

export {
  addMember,
  removeMember,
  updateRole,
  listMembers,
  getUserWorkspaces,
  getUserAccess,
  isMember,
  countMembers,
  findSystemRoleOrThrow,
  type UpdateRoleInput,
  type UpdateRoleResult,
  type WorkspaceMembership,
} from "./members.js";

export {
  setDefault,
  getDefault,
  clearDefault,
  assignToDefault,
  ensureDefaultExists,
} from "./defaults.js";
