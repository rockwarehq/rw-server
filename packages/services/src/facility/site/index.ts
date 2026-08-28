// Site service - public API
// Re-exports all site-related functionality

export * as crud from "./crud.js";
export * as andonRules from "./andon-rules.js";
export * as logo from "./logo.js";
export * as settings from "./settings.js";

// Re-export commonly used functions at top level for convenience
export {
  create,
  list,
  getById,
  getTree,
  getSiteTree,
  getDeviceTree,
  update,
  remove,
  type CreateSiteInput,
} from "./crud.js";

export {
  createLogoUpload,
  removeLogo,
  resolveLogoUrl,
  type CreateLogoUploadInput,
} from "./logo.js";

export {
  getSiteSettings,
  updateSiteSettings,
  parseSiteSettings,
  type SiteSettings,
} from "./settings.js";

export type { UpdateSiteInput, ListSitesFilter } from "./crud.js";
