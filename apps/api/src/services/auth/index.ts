// Auth service - public API
// Re-exports all auth-related functionality

export * as tokens from "./tokens.js";
export * as session from "./session.js";
export * as displaySession from "./display-session.js";
export { Principal, type IAMContext, type PrincipalType } from "./context.js";
export { authPlugin } from "./plugin.js";

// Re-export commonly used functions at top level for convenience
export {
  createAccessToken,
  verifyAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  type AccessTokenPayload,
  type DisplayAccessTokenPayload,
  type AnyAccessTokenPayload,
  type DecodedAccessToken,
  createDisplayRefreshToken,
  verifyDisplayRefreshToken,
  revokeDisplayRefreshToken,
  revokeAllDisplayRefreshTokens,
} from "./tokens.js";

export {
  login,
  logout,
  logoutAll,
  refreshSession,
  switchWorkspace,
  switchSite,
  hashPassword,
  comparePassword,
  type LoginResult,
  type TokenPair,
} from "./session.js";

export {
  loginDisplay,
  refreshDisplaySession,
  logoutDisplay,
  type DisplayAuthResult,
  type DisplayTokenPair,
} from "./display-session.js";
