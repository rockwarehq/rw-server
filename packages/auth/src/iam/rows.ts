import prisma from "@rw/db";

// Where a row lives decides who may touch it. access.ts looks the row up
// here (a narrow read of its siteId, and workcenterId for floor rows)
// before any data is fetched, then checks the caller's access there.
//
// Plant data: shared by every workcenter at the plant (jobs, products,
// tools, materials, orders, customers, reason codes, shift patterns…).
// Everyone at the plant can see it, crew included, so they can pick a job
// or look up a part. Only plant members can change it.
//
// Workcenter data: what happens on the floor (cycles, state logs, calls,
// inventory made, dispositions) and the stations themselves. It is checked
// on its workcenter's bucket: crew see and change only their own
// workcenters' data. A row whose workcenterId is null is plant data.
//
// The rule when adding a kind: if the row has a workcenterId (on itself or
// its station), return it here — otherwise the row is checked as plant
// data and crew of other workcenters can read it.
//
// Which jobs show up at which station is NOT decided here; that is labels
// and station label filters.
//
// Missing row => null => NOT_FOUND. A row with `siteId: null` (unassigned
// gateways/datasources, unclaimed displays, workspace-level documents,
// global object schemas) is NOT a not-found: access.ts applies the
// "somewhere" rule to it. No soft-delete filtering here: services keep
// producing their own *_DELETED error codes after the check (ADR-0003).

export type SiteRow = { siteId: string | null; workcenterId?: string | null } | null;

const one = (row: { siteId: string | null } | null): SiteRow => row;
const via = (row: { siteId: string | null } | null | undefined): SiteRow => (row ? { siteId: row.siteId } : null);
const viaStation = (row: { siteId: string | null; workcenterId: string | null } | null | undefined): SiteRow =>
  row ? { siteId: row.siteId, workcenterId: row.workcenterId } : null;

export const RESOLVERS = {
  // ── Workcenter data (checked on the row's workcenter) ────────────────
  station: (id: string) =>
    prisma.station.findUnique({ where: { id }, select: { siteId: true, workcenterId: true } }).then(one),
  workcenter: (id: string) =>
    prisma.workcenter
      .findUnique({ where: { id }, select: { siteId: true } })
      .then((r) => (r ? { siteId: r.siteId, workcenterId: id } : null)),
  stationStateLog: (id: string) =>
    prisma.stationStateLog
      .findUnique({ where: { id }, select: { station: { select: { siteId: true, workcenterId: true } } } })
      .then((r) => viaStation(r?.station)),
  cycle: (id: string) =>
    prisma.cycle.findUnique({ where: { id }, select: { siteId: true, workcenterId: true } }).then(one),
  inventoryItem: (id: string) =>
    prisma.inventoryItem
      .findUnique({ where: { id }, select: { workcenterId: true, cycle: { select: { siteId: true } } } })
      .then((r) => (r ? { siteId: r.cycle.siteId, workcenterId: r.workcenterId } : null)),
  call: (id: string) =>
    prisma.call.findUnique({ where: { id }, select: { siteId: true, workcenterId: true } }).then(one),
  dispositionLog: (id: string) =>
    prisma.itemDispositionLog.findUnique({ where: { id }, select: { siteId: true, workcenterId: true } }).then(one),
  shiftComment: (id: string) =>
    prisma.shiftComment.findUnique({ where: { id }, select: { siteId: true, workcenterId: true } }).then(one),

  // ── Plant data (shared by every workcenter at the plant) ─────────────
  job: (id: string) => prisma.job.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  jobProduct: (id: string) =>
    prisma.jobProduct
      .findUnique({ where: { id }, select: { job: { select: { siteId: true } } } })
      .then((r) => via(r?.job)),
  product: (id: string) => prisma.product.findUnique({ where: { id }, select: { siteId: true } }).then(one),
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
  material: (id: string) => prisma.material.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  tool: (id: string) => prisma.tool.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  toolCavity: (id: string) =>
    prisma.toolCavity
      .findUnique({ where: { id }, select: { tool: { select: { siteId: true } } } })
      .then((r) => via(r?.tool)),
  order: (id: string) => prisma.order.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  orderLineItem: (id: string) =>
    prisma.orderLineItem
      .findUnique({ where: { id }, select: { order: { select: { siteId: true } } } })
      .then((r) => via(r?.order)),
  customer: (id: string) => prisma.customer.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  label: (id: string) => prisma.label.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  statusReason: (id: string) => prisma.statusReason.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  statusCategory: (id: string) =>
    prisma.statusCategory.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  disposition: (id: string) => prisma.itemDisposition.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  dispositionReason: (id: string) =>
    prisma.itemDispositionReason.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  callDefinition: (id: string) =>
    prisma.callDefinition.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  productionMode: (id: string) =>
    prisma.productionMode.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  shiftPattern: (id: string) => prisma.shiftPattern.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  shiftDefinition: (id: string) =>
    prisma.shiftDefinition
      .findUnique({ where: { id }, select: { pattern: { select: { siteId: true } } } })
      .then((r) => via(r?.pattern)),
  shiftAssignment: (id: string) =>
    prisma.shiftAssignment.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  employeeRole: (id: string) => prisma.employeeRole.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  dashboard: (id: string) => prisma.dashboard.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  savedView: (id: string) => prisma.savedView.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  siteAndonRule: (id: string) => prisma.siteAndonRule.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  notificationGroup: (id: string) =>
    prisma.notificationGroup.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  notification: (id: string) => prisma.notification.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  integration: (id: string) => prisma.integration.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  integrationTrigger: (id: string) =>
    prisma.integrationTrigger.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  graphNode: (id: string) => prisma.graphNode.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  graphNodeType: (id: string) => prisma.graphNodeType.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  graphHook: (id: string) => prisma.graphHook.findUnique({ where: { id }, select: { siteId: true } }).then(one),
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

  // ── May have no site (null => the "somewhere" rule) ──────────────────
  gateway: (id: string) => prisma.gateway.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  datasource: (id: string) => prisma.datasource.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  point: (id: string) =>
    prisma.point
      .findUnique({ where: { id }, select: { datasource: { select: { siteId: true } } } })
      .then((r) => via(r?.datasource)),
  pointGroup: (id: string) =>
    prisma.pointGroup
      .findUnique({ where: { id }, select: { datasource: { select: { siteId: true } } } })
      .then((r) => via(r?.datasource)),
  display: (id: string) =>
    prisma.display.findUnique({ where: { id }, select: { siteId: true, workcenterId: true } }).then(one),
  document: (id: string) => prisma.document.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  objectSchema: (id: string) => prisma.objectSchema.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  objectInstance: (id: string) =>
    prisma.objectInstance.findUnique({ where: { id }, select: { siteId: true } }).then(one),
  automation: (id: string) => prisma.automation.findUnique({ where: { id }, select: { siteId: true } }).then(one),
} satisfies Record<string, (id: string) => Promise<SiteRow>>;

export type RowKind = keyof typeof RESOLVERS;

/** Kinds whose rows can live at no site; every other kind always has one. */
export type SitelessRowKind =
  | "gateway"
  | "datasource"
  | "display"
  | "document"
  | "objectSchema"
  | "objectInstance"
  | "automation"
  | "point"
  | "pointGroup";

/** A row reference: exactly one `{ kind: id }` pair, e.g. `{ station: id }`. */
export type RowRef = { [K in RowKind]: { [P in K]: string } & { [P in Exclude<RowKind, K>]?: never } }[RowKind];

export function rowRefParts(ref: RowRef): { kind: RowKind; id: string } {
  const [kind, id] = Object.entries(ref).find(([, v]) => v !== undefined) as [RowKind, string];
  return { kind, id };
}

export async function locateRow(kind: RowKind, id: string): Promise<SiteRow> {
  return RESOLVERS[kind](id);
}

export const NOT_FOUND_MESSAGES: Record<RowKind, string> = {
  station: "Station not found",
  workcenter: "Workcenter not found",
  label: "Label not found",
  stationStateLog: "State log entry not found",
  order: "Order not found",
  orderLineItem: "Order line item not found",
  customer: "Customer not found",
  statusReason: "Status reason not found",
  statusCategory: "Status category not found",
  call: "Call not found",
  callDefinition: "Call definition not found",
  productionMode: "Production mode not found",
  notificationGroup: "Notification group not found",
  notification: "Notification not found",
  disposition: "Disposition not found",
  dispositionReason: "Disposition reason not found",
  dispositionLog: "Disposition log not found",
  tool: "Tool not found",
  toolCavity: "Tool cavity not found",
  job: "Job not found",
  jobProduct: "Job item not found",
  product: "Product not found",
  productMaterial: "Product material not found",
  productAltGroup: "Alternative group not found",
  productPicture: "Product picture not found",
  material: "Material not found",
  inventoryItem: "Inventory item not found",
  dashboard: "Dashboard not found",
  savedView: "Saved view not found",
  shiftPattern: "Shift pattern not found",
  shiftDefinition: "Shift definition not found",
  shiftAssignment: "Shift assignment not found",
  shiftComment: "Shift comment not found",
  employeeRole: "Employee role not found",
  cycle: "Cycle not found",
  graphNode: "Graph node not found",
  graphNodeType: "Graph node type not found",
  graphTypeField: "Graph type field not found",
  graphTypeInput: "Graph type input not found",
  graphTypeFacet: "Graph type facet not found",
  graphProperty: "Graph property not found",
  graphHook: "Graph hook not found",
  integration: "Integration not found",
  integrationTrigger: "Integration trigger not found",
  siteAndonRule: "Andon rule not found",
  gateway: "Gateway not found",
  datasource: "Datasource not found",
  display: "Display not found",
  document: "Document not found",
  objectSchema: "Schema not found",
  objectInstance: "Instance not found",
  automation: "Automation not found",
  point: "Point not found",
  pointGroup: "Point group not found",
};
