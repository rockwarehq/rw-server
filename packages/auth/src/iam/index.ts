// IAM — bucket-based access control for the User principal tier.
//
// Rows live in containers (a PLANT bucket per site, a WORKCENTER bucket
// per cell); access is membership in the container with a tier
// (VIEW < MANAGE < ADMIN). Workspace owners and Rockware staff bypass.
// See iam/buckets.ts for the model and policy.ts for the call-site gate.

export {
  TIER_RANK,
  tierAtLeast,
  completeSnapshotEntries,
  loadBucketSnapshot,
  ownerSnapshot,
  staffSnapshot,
  snapshotTierInBucket,
  snapshotPlantTier,
  snapshotWorkcenterTier,
  snapshotVisibleSites,
  snapshotWorkcenterIds,
  type BucketKind,
  type BucketTier,
  type BucketAccessVia,
  type BucketEntry,
  type BucketSnapshot,
  type VisibleSites,
} from "./buckets.js";

export {
  authorize,
  authorizeList,
  authorizeAccessibleSites,
  createPolicy,
  scopeFilter,
  scopeWhere,
  scopeWorkcenterWhere,
  type AuthorizeFn,
  type ListPolicyResult,
  type ListScope,
  type PolicyDenial,
  type PolicyDeps,
  type PolicyResult,
  type ScopeRef,
  type SiteDirectoryScope,
  type SiteGrant,
  type WorkspaceGrant,
} from "./policy.js";
