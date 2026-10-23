import type { OAuthScope } from "../oauth/store.js";

// What a person's connected agent (an OAuth caller, `current.via`) may call,
// by procedure path. This is an allowlist: a procedure missing here is closed
// to agents, so a new mutation never becomes agent-callable by accident. The
// scope is a ceiling — each procedure still checks the person's own access.
//
// `setup:propose` implies `read` (see normalizeScopes).
export const AGENT_CALLABLE: Readonly<Record<string, OAuthScope>> = {
  "site.get": "read",
  "workcenter.list": "read",
  "workcenter.get": "read",
  "station.list": "read",
  "station.get": "read",
  "material.list": "read",
  "material.get": "read",
  "product.list": "read",
  "product.get": "read",
  "tool.list": "read",
  "tool.get": "read",
  "tool.listCavities": "read",
  "job.list": "read",
  "job.get": "read",
  "job.listTools": "read",
  "job.listItems": "read",
  // Setup changesets: an agent proposes and revises its person's drafts.
  // Applying is never here: a person applies in IMM.
  "setup.changeset.list": "read",
  "setup.changeset.get": "read",
  "setup.changeset.create": "setup:propose",
  "setup.changeset.replan": "setup:propose",
  "setup.changeset.discard": "setup:propose",
  "setup.changeset.rows": "read",
  "setup.upload.create": "setup:propose",
};

/** The scope a connected agent needs for this procedure, or null when closed to agents. */
export function scopeForProcedure(path: readonly string[]): OAuthScope | null {
  return AGENT_CALLABLE[path.join(".")] ?? null;
}
