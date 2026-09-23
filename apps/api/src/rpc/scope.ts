import type { Current } from "@rw/auth/context";
import type { Access, Target, Tier } from "@rw/auth/iam/access";
import type { SitelessRowKind } from "@rw/auth/iam/rows";

/**
 * Check access, then return the `{ workspaceId, siteId }` pair that the
 * livestore graph API (and integration services) take as their scope.
 * Site-less row kinds are not allowed here: these scopes always need a site.
 */
export async function workspaceSiteScope<T extends Target>(
  context: { current: Current; access: Access },
  tier: Tier,
  target: T & { [K in SitelessRowKind]?: never },
): Promise<{ workspaceId: string; siteId: string }> {
  const { siteId } = await context.access.require(tier, target);
  return { workspaceId: context.current.workspaceId, siteId: siteId as string };
}
