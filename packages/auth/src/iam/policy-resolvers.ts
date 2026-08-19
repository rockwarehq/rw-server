import prisma from "@rw/db";

// Site derivation for resource-scoped authorization checks. Each resolver is
// a narrow read of the denormalized siteId column (or one required-parent
// hop) — deliberately narrower than service getById calls so the policy can
// decide before any data is fetched.
//
// Missing row => null => NOT_FOUND. A row with `siteId: null` (resources
// that can exist without a site: unassigned gateways/datasources, unclaimed
// displays, workspace-level documents, global object schemas) is NOT a
// not-found — policy.ts applies the anySite rule to it.
//
// No soft-delete filtering here: services must keep producing their own
// *_DELETED error codes after authorization (wire parity, ADR-0003).

export type SiteRow = { siteId: string | null } | null;

const one = (row: { siteId: string | null } | null): SiteRow => row;
const via = (row: { siteId: string | null } | null | undefined): SiteRow => (row ? { siteId: row.siteId } : null);

export const RESOLVERS = {
  // ── direct siteId column ────────────────────────────────────────────
  station: (id: string) => prisma.station.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  workcenter: (id: string) => prisma.workcenter.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  order: (id: string) => prisma.order.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  customer: (id: string) => prisma.customer.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  processType: (id: string) => prisma.processType.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  statusReason: (id: string) => prisma.statusReason.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  statusCategory: (id: string) =>
    prisma.statusCategory.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  disposition: (id: string) => prisma.itemDisposition.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  dispositionReason: (id: string) =>
    prisma.itemDispositionReason.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  dispositionLog: (id: string) =>
    prisma.itemDispositionLog.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  tool: (id: string) => prisma.tool.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  job: (id: string) => prisma.job.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  product: (id: string) => prisma.product.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  material: (id: string) => prisma.material.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  dashboard: (id: string) => prisma.dashboard.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  savedView: (id: string) => prisma.savedView.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  shiftPattern: (id: string) => prisma.shiftPattern.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  shiftAssignment: (id: string) =>
    prisma.shiftAssignment.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  shiftComment: (id: string) => prisma.shiftComment.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  employeeRole: (id: string) => prisma.employeeRole.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  cycle: (id: string) => prisma.cycle.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  graphNode: (id: string) => prisma.graphNode.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  graphNodeType: (id: string) => prisma.graphNodeType.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  graphHook: (id: string) => prisma.graphHook.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  integration: (id: string) => prisma.integration.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  integrationTrigger: (id: string) =>
    prisma.integrationTrigger.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  siteAndonRule: (id: string) => prisma.siteAndonRule.findUnique({ where: { id }, select: { siteId: true } }).then(one),

  // ── nullable siteId column (null => anySite rule in policy.ts) ─────
  gateway: (id: string) => prisma.gateway.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  datasource: (id: string) => prisma.datasource.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  display: (id: string) => prisma.display.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  document: (id: string) => prisma.document.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  objectSchema: (id: string) => prisma.objectSchema.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  objectInstance: (id: string) =>
    prisma.objectInstance.findUnique({ where: { id }, select: { siteId: true } }).then(one),

  // ── one hop through a required parent ───────────────────────────────
  stationStateLog: (id: string) =>
    prisma.stationStateLog
      .findUnique({ where: { id }, select: { station: { select: { siteId: true } } } })
      .then((r) => via(r?.station)),
  orderLineItem: (id: string) =>
    prisma.orderLineItem
      .findUnique({ where: { id }, select: { order: { select: { siteId: true } } } })
      .then((r) => via(r?.order)),
  toolCavity: (id: string) =>
    prisma.toolCavity
      .findUnique({ where: { id }, select: { tool: { select: { siteId: true } } } })
      .then((r) => via(r?.tool)),
  jobProduct: (id: string) =>
    prisma.jobProduct
      .findUnique({ where: { id }, select: { job: { select: { siteId: true } } } })
      .then((r) => via(r?.job)),
  productMaterial: (id: string) =>
    prisma.productMaterial
      .findUnique({ where: { id }, select: { product: { select: { siteId: true } } } })
      .then((r) => via(r?.product)),
  productAltGroup: (id: string) =>
    prisma.productMaterialAltGroup
      .findUnique({ where: { id }, select: { product: { select: { siteId: true } } } })
      .then((r) => via(r?.product)),
  productPicture: (id: string) =>
    prisma.productPicture
      .findUnique({ where: { id }, select: { product: { select: { siteId: true } } } })
      .then((r) => via(r?.product)),
  inventoryItem: (id: string) =>
    prisma.inventoryItem
      .findUnique({ where: { id }, select: { cycle: { select: { siteId: true } } } })
      .then((r) => via(r?.cycle)),
  shiftDefinition: (id: string) =>
    prisma.shiftDefinition
      .findUnique({ where: { id }, select: { pattern: { select: { siteId: true } } } })
      .then((r) => via(r?.pattern)),
  graphProperty: (id: string) =>
    prisma.graphProperty
      .findUnique({ where: { id }, select: { node: { select: { siteId: true } } } })
      .then((r) => via(r?.node)),
  graphTypeField: (id: string) =>
    prisma.graphNodeTypeField
      .findUnique({ where: { id }, select: { type: { select: { siteId: true } } } })
      .then((r) => via(r?.type)),
  graphTypeInput: (id: string) =>
    prisma.graphNodeTypeInput
      .findUnique({ where: { id }, select: { type: { select: { siteId: true } } } })
      .then((r) => via(r?.type)),
  graphTypeFacet: (id: string) =>
    prisma.graphNodeTypeFacet
      .findUnique({ where: { id }, select: { type: { select: { siteId: true } } } })
      .then((r) => via(r?.type)),
  point: (id: string) =>
    prisma.point
      .findUnique({ where: { id }, select: { datasource: { select: { siteId: true } } } })
      .then((r) => via(r?.datasource)),
  pointGroup: (id: string) =>
    prisma.pointGroup
      .findUnique({ where: { id }, select: { datasource: { select: { siteId: true } } } })
      .then((r) => via(r?.datasource)),
} satisfies Record<string, (id: string) => Promise<SiteRow>>;

export type ResolvableKind = keyof typeof RESOLVERS;

/**
 * Kinds whose rows can legitimately carry siteId null (or a null-site
 * parent): authorize() may return a WorkspaceGrant for these. All other
 * resolvable kinds always prove a concrete siteId.
 */
export const NULLABLE_SITE_KINDS = [
  "gateway",
  "datasource",
  "display",
  "document",
  "objectSchema",
  "objectInstance",
  "point",
  "pointGroup",
] as const satisfies readonly ResolvableKind[];

export type NullableSiteKind = (typeof NULLABLE_SITE_KINDS)[number];

export type ResolvableSiteRef = { kind: ResolvableKind; id: string };

export async function resolveSiteRef(ref: ResolvableSiteRef): Promise<SiteRow> {
  return RESOLVERS[ref.kind](ref.id);
}
