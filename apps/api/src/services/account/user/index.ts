// User service - public API
// Re-exports all user-related functionality

export * as crud from "./crud.js";
export * as invite from "./invite.js";
export * as password from "./password.js";
export * as avatar from "./avatar.js";

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
  revokeInvite,
  type CreateInviteInput,
  type InviteResult,
  type RevokeInviteError,
  type InviteContext,
} from "./invite.js";

export {
  createAvatarUpload,
  removeAvatar,
  resolveAvatarUrl,
  type CreateAvatarUploadInput,
} from "./avatar.js";

export {
  initiateReset,
  verifyResetCode,
  resetPassword,
  changePassword,
  adminSetPassword,
  type ResetRequestResult,
  type ResetContext,
  type AdminSetPasswordInput,
  type AdminSetPasswordError,
  type AdminSetPasswordResult,
} from "./password.js";
