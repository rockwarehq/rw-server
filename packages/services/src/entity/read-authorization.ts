import type { IAMContext } from "@rw/auth/context";
import { authorizeList, authorizeReferenceRead } from "@rw/auth/iam/policy";
import { SYSTEM_ENTITY_KEYS as K } from "./registry.js";

/** Native dispatch must use its domain, never a generic entity permission. */
export function authorizeEntityInstances(iam: IAMContext, key?: string) {
  const siteId = iam.siteId;
  if ([K.Site, K.Job, K.Product, K.Material, K.Tool, K.StatusReason, K.StatusCategory].includes(key as never)) {
    return authorizeReferenceRead(iam, { scope: siteId ? { kind: "site", siteId } : { kind: "workspace" } });
  }
  const permission = [K.Customer, K.Order, K.WorkOrder, K.ShiftInstance].includes(key as never)
    ? "planning:read"
    : key === K.Employee
      ? "plant:admin"
      : [K.Station, K.Workcenter, K.Call].includes(key as never)
        ? "production:read"
        : "configuration:read";
  return authorizeList(iam, { permission, requestedSiteId: siteId });
}
