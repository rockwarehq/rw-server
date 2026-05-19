// User service - public API
// Re-exports all user-related functionality

export * as crud from "./crud.js";
export * as invite from "./invite.js";
export * as password from "./password.js";

// Re-export commonly used functions at top level for convenience
export {
  create,
  list,
  getMe,
  getById,
  getByEmail,
  update,
  disable,
  enable,
  exists,
  emailExists,
  unlockAccount,
  getLockStatus,
  type CreateUserInput,
  type UpdateUserInput,
  type ListUsersFilter,
  type UnlockContext,
} from "./crud.js";

export {
  createInvite,
  verifyInviteToken,
  completeInvite,
  type CreateInviteInput,
  type InviteResult,
  type CompleteInviteInput,
  type InviteContext,
} from "./invite.js";

export {
  initiateReset,
  verifyResetToken,
  resetPassword,
  changePassword,
  type ResetRequestResult,
  type ResetContext,
} from "./password.js";
