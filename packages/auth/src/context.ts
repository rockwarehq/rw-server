export const Principal = {
  USER: "USER",
  DISPLAY: "DISPLAY",
  WORKER: "WORKER",
  // Opaque customer/app API token ("rw_app_..."), site-scoped and read-only.
  APP: "APP",
  UNKNOWN: "UNKNOWN",
} as const;

export type PrincipalType = (typeof Principal)[keyof typeof Principal];

/**
 * Bucket-access state resolved once per request by the auth plugin.
 * Structural twin of BucketSnapshot in iam/buckets.ts (kept import-free
 * here); lets policy checks evaluate without re-querying.
 */
export interface IAMBucketSnapshot {
  owner: boolean;
  staff: "NONE" | "READ" | "FULL";
  entries: Array<{
    bucketId: string;
    kind: "PLANT" | "WORKCENTER";
    siteId: string | null;
    workcenterId: string | null;
    tier: "VIEW" | "MANAGE" | "ADMIN";
    via: "direct" | "member" | "cascade";
  }>;
}

interface BaseIAMContext {
  principal: PrincipalType;
  validToken: boolean;
  id?: string;
  email?: string;
  workspaceId?: string;
  displayId?: string;
  siteId?: string;
  workspace?: {
    id: string;
    name: string;
    slug: string;
  };
  bucketSnapshot?: IAMBucketSnapshot;
}

export interface IAMContext extends BaseIAMContext {
  user?: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    status: string;
    // When true, the API blocks everything except password change and
    // session endpoints (enforced by the auth plugin).
    mustChangePassword?: boolean;
  };
  display?: {
    id: string;
    name: string | null;
    status: string;
    siteId: string;
    dashboardId: string | null;
    workcenterId: string | null;
    stationId: string | null;
  };
}

export interface UnknownIAMContext extends IAMContext {
  principal: typeof Principal.UNKNOWN;
  validToken: false;
}

export interface UserIAMContext extends IAMContext {
  principal: typeof Principal.USER;
  validToken: true;
  id: string;
  email: string;
  workspaceId?: string;
  siteId?: string;
}

export interface DisplayIAMContext extends IAMContext {
  principal: typeof Principal.DISPLAY;
  validToken: true;
  displayId: string;
  siteId: string;
  workspaceId: string;
}

export interface AppIAMContext extends IAMContext {
  principal: typeof Principal.APP;
  validToken: true;
  apiTokenId: string;
  siteId: string;
  workspaceId: string;
  scopes: string[];
}
