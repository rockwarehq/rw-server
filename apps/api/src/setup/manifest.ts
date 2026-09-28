// The setup catalog: everything a person can set up in Rockware, written down
// for the setup assistant. Each entry names a real RPC procedure (the router
// path), what it does in plain words, and how careful to be with it.
//
// The input rules are NOT written here. They are read from the live router
// (catalog.ts), so they can never drift from what the server accepts. A test
// checks every path here exists on the router.
//
// Access levels are what the server checks: VIEW < MANAGE < ADMIN at the
// plant, and ACCOUNT_ADMIN for workspace-wide things. The assistant only uses
// them to plan; the server still decides every call.
//
// Domains are listed in the order a new plant is usually set up.

export type Level = "VIEW" | "MANAGE" | "ADMIN" | "ACCOUNT_ADMIN";
export type ActionKind = "read" | "write" | "delete";

export interface ActionMeta {
  kind: ActionKind;
  level: Level;
  summary: string;
  /** Why to slow down: shown on the plan card and needs its own tick. */
  danger?: string;
}

export interface SetupDomain {
  label: string;
  description: string;
  /** What must exist first (domain keys). */
  dependsOn?: string[];
  /** Things to know before changing this area. */
  notes?: string;
  actions: Record<string, ActionMeta>;
}

const read = (summary: string): ActionMeta => ({ kind: "read", level: "VIEW", summary });
const write = (level: Level, summary: string, danger?: string): ActionMeta => ({
  kind: "write",
  level,
  summary,
  ...(danger ? { danger } : {}),
});
const remove = (level: Level, summary: string, danger: string): ActionMeta => ({
  kind: "delete",
  level,
  summary,
  danger,
});

export const SETUP_DOMAINS: Record<string, SetupDomain> = {
  plant: {
    label: "Plant",
    description: "The plant (site) itself: its name, time zone, logo, order settings and andon color rules.",
    notes:
      "The time zone decides which work day every shift and report lands on; set it before shifts. Andon rules color station tiles by a condition; the first matching rule wins, so order matters.",
    actions: {
      "site.list": read("List the plants you can see."),
      "site.get": read("Get one plant."),
      "site.tree": read("Get a plant with its workcenters and stations."),
      "site.getSettings": read("Get plant settings (order auto-complete)."),
      "site.update": write("ADMIN", "Change the plant's name, description, time zone or settings stored in attrs."),
      "site.updateSettings": write("ADMIN", "Change plant settings (order auto-complete)."),
      "site.removeLogo": write("ADMIN", "Remove the plant logo."),
      "site.create": write("ACCOUNT_ADMIN", "Create a new plant. Set its time zone right after."),
      "site.delete": remove(
        "ACCOUNT_ADMIN",
        "Delete a plant.",
        "Deletes the whole plant. Only works once it has no workcenters, gateways or datasources.",
      ),
      "site.andonRules.list": read("List the andon color rules, in priority order."),
      "site.andonRules.create": write("ADMIN", "Add an andon color rule: a condition, a color and a name."),
      "site.andonRules.update": write("ADMIN", "Change an andon rule."),
      "site.andonRules.reorder": write("ADMIN", "Change the order andon rules are checked in."),
      "site.andonRules.delete": remove("ADMIN", "Delete an andon rule.", "Stations lose this color right away."),
    },
  },

  labels: {
    label: "Labels",
    description:
      "Colored tags for jobs, tools, products, materials, stations and reasons. Stations can use them to narrow what operators can pick.",
    notes: "Create labels early; other things point at them. A label used in a station filter can't be deleted.",
    actions: {
      "label.list": read("List labels."),
      "label.get": read("Get one label."),
      "label.create": write("MANAGE", "Create a label with a name and a color (#RRGGBB)."),
      "label.update": write("MANAGE", "Rename or recolor a label."),
      "label.delete": remove("MANAGE", "Delete a label.", "Removes the label from everything it's on."),
    },
  },

  workcenters: {
    label: "Workcenters",
    description: "Groups of stations, like a line or an area. Access to the floor is granted per workcenter.",
    dependsOn: ["plant"],
    notes: "Workcenters are flat (no nesting). Each one gets its own access group automatically.",
    actions: {
      "workcenter.list": read("List workcenters."),
      "workcenter.get": read("Get one workcenter."),
      "workcenter.create": write("ADMIN", "Create a workcenter."),
      "workcenter.update": write("ADMIN", "Rename a workcenter or change its settings stored in attrs."),
      "workcenter.delete": remove(
        "ADMIN",
        "Delete a workcenter.",
        "Only works when it has no stations. Removes its access group.",
      ),
    },
  },

  profiles: {
    label: "Station profiles",
    description:
      "How a kind of machine counts: per cycle, by amount per cycle, or by amount over time. Every plant has a fixed 'Discrete' default.",
    dependsOn: ["plant"],
    notes: "Only needed for machines that don't count one part per cycle. A profile in use can't change how it counts.",
    actions: {
      "stationProfile.list": read("List station profiles."),
      "stationProfile.get": read("Get one profile."),
      "stationProfile.getDefault": read("Get the plant's default (Discrete) profile."),
      "stationProfile.create": write("ADMIN", "Create a station profile."),
      "stationProfile.update": write("ADMIN", "Change a station profile."),
      "stationProfile.archive": write(
        "ADMIN",
        "Archive a profile. The Discrete default can't be archived.",
        "Stations using it keep it, but it can't be picked any more.",
      ),
    },
  },

  stations: {
    label: "Stations",
    description:
      "The machines or work spots that make parts. Each has a speed standard, slow and down detection, labels and label filters.",
    dependsOn: ["workcenters"],
    notes:
      "Put every station in a workcenter, or people with workcenter access won't see it. Each change makes a new station version. downtimeDetect is seconds without a cycle before it counts as down; slowDetect is a percent of standard.",
    actions: {
      "station.list": read("List stations."),
      "station.get": read("Get one station with its settings."),
      "station.create": write("ADMIN", "Create a station, usually in a workcenter."),
      "station.update": write(
        "ADMIN",
        "Change a station's name, standards, detection, profile or labels. labelIds replaces the whole list.",
      ),
      "station.move": write("ADMIN", "Move a station to another workcenter."),
      "station.delete": remove(
        "ADMIN",
        "Delete a station.",
        "Permanent. Stations with recorded history usually can't be deleted; move or rename them instead.",
      ),
      "station.listLabelFilters": read("List a station's label filters."),
      "station.setLabelFilter": write(
        "ADMIN",
        "Limit which jobs, tools or reasons operators can pick at a station, by label. Empty clears it.",
      ),
      "station.listEvents": read("List a station's tag-triggered events."),
      "station.createEvent": write("ADMIN", "Add a station event: when a machine tag does something, run actions."),
      "station.updateEvent": write("ADMIN", "Change a station event (needs its current version)."),
      "station.toggleEvent": write("ADMIN", "Turn a station event on or off."),
      "station.deleteEvent": remove("ADMIN", "Delete a station event.", "The event stops firing."),
      "station.listDatasources": read("List the machine connections a station uses."),
      "station.addDatasource": write("ADMIN", "Connect a datasource to a station."),
      "station.removeDatasource": write(
        "ADMIN",
        "Disconnect a datasource from a station.",
        "The station stops getting machine signals from it.",
      ),
    },
  },

  devices: {
    label: "Gateways and datasources",
    description: "The edge boxes and machine connections that bring signals in from the floor.",
    dependsOn: ["plant"],
    notes:
      "Datasources start as drafts; publish them to start collecting. Point and group setup is done in the device tools, not here.",
    actions: {
      "site.deviceTree": read("Get the plant's gateways and datasources."),
      "gateway.list": read("List gateways."),
      "gateway.get": read("Get one gateway."),
      "gateway.create": write("ADMIN", "Add a gateway."),
      "gateway.update": write("ADMIN", "Change a gateway."),
      "gateway.delete": remove("ADMIN", "Delete a gateway.", "Machine signals through it stop."),
      "datasource.list": read("List datasources."),
      "datasource.get": read("Get one datasource."),
      "datasource.create": write("ADMIN", "Add a datasource (starts as a draft)."),
      "datasource.update": write("ADMIN", "Change a datasource."),
      "datasource.publish": write("ADMIN", "Publish a datasource so it starts collecting."),
      "datasource.unpublish": write("ADMIN", "Unpublish a datasource.", "It stops collecting."),
      "datasource.delete": remove("ADMIN", "Delete a datasource.", "Its signals stop and stations lose it."),
    },
  },

  shifts: {
    label: "Shifts",
    description:
      "Shift schedules: a pattern of shifts over a rotation of days, published to the plant or one workcenter. Overrides change future days; amendments fix days that already ran.",
    dependsOn: ["plant", "workcenters"],
    notes:
      "Build a pattern, add its shift definitions (start time HH:mm, hours, day of the rotation), then publish it with a shiftAssignment. A workcenter's own schedule beats the plant's. Nothing counts as scheduled until a pattern is published.",
    actions: {
      "shift.current": read("Which shift is on now."),
      "shiftPattern.list": read("List shift patterns."),
      "shiftPattern.get": read("Get one pattern with its shifts."),
      "shiftPattern.create": write("ADMIN", "Create a shift pattern (rotation length, start day)."),
      "shiftPattern.update": write("ADMIN", "Change a shift pattern."),
      "shiftPattern.duplicate": write("ADMIN", "Copy a shift pattern."),
      "shiftPattern.delete": remove(
        "ADMIN",
        "Delete a shift pattern.",
        "If it's published, it is unpublished first and future shifts go away.",
      ),
      "shiftDefinition.list": read("List the shifts in a pattern."),
      "shiftDefinition.get": read("Get one shift definition."),
      "shiftDefinition.create": write("ADMIN", "Add a shift to a pattern."),
      "shiftDefinition.update": write("ADMIN", "Change a shift in a pattern."),
      "shiftDefinition.delete": remove("ADMIN", "Remove a shift from a pattern.", "Future days lose this shift."),
      "shiftAssignment.list": read("List published schedules."),
      "shiftAssignment.get": read("Get one published schedule."),
      "shiftAssignment.preview": read("See the real shifts a schedule makes over some dates."),
      "shiftAssignment.create": write("ADMIN", "Publish a pattern to the plant or a workcenter from a start date."),
      "shiftAssignment.update": write("ADMIN", "Change a published schedule's dates."),
      "shiftAssignment.unpublish": write(
        "ADMIN",
        "Stop a published schedule.",
        "Future shifts that aren't in use are removed.",
      ),
      "shiftOverride.list": read("List one-off changes to future days."),
      "shiftOverride.get": read("Get one override."),
      "shiftOverride.create": write("MANAGE", "Change a future day: different hours, or no shift."),
      "shiftOverride.update": write("MANAGE", "Change an override."),
      "shiftOverride.delete": remove("MANAGE", "Remove an override.", "The day goes back to the normal schedule."),
      "shiftAmendment.list": read("List fixes to days that already ran."),
      "shiftAmendment.create": write(
        "MANAGE",
        "Fix the shifts of a day that already ran.",
        "Rewrites history: reports for that day change.",
      ),
      "shiftAmendment.undo": write("MANAGE", "Undo a past-day fix.", "Rewrites history: reports for that day change."),
    },
  },

  catalog: {
    label: "Products, materials, tools and jobs",
    description:
      "What the plant makes and makes it with. Products have bills of materials; tools have cavities; a job says which products a station makes, with which tool, how fast.",
    dependsOn: ["plant"],
    notes:
      "Order: materials, products (and their materials), tools (and cavities), then jobs with their tools and products. Edits make new versions. Changing a job that is running on a station can make job and station numbers disagree until the next job change.",
    actions: {
      "material.list": read("List materials."),
      "material.get": read("Get one material."),
      "material.create": write("MANAGE", "Create a material."),
      "material.update": write("MANAGE", "Change a material."),
      "material.delete": remove("MANAGE", "Delete a material.", "Only works when no product uses it."),
      "product.list": read("List products."),
      "product.get": read("Get one product."),
      "product.create": write("MANAGE", "Create a product (SKU, name, weight, cost)."),
      "product.update": write("MANAGE", "Change a product."),
      "product.duplicate": write("MANAGE", "Copy a product under a new SKU."),
      "product.archive": write("MANAGE", "Archive a product."),
      "product.unarchive": write("MANAGE", "Bring back an archived product."),
      "product.delete": remove("MANAGE", "Delete a product.", "Only works when no job makes it."),
      "product.listMaterials": read("List a product's materials."),
      "product.addMaterial": write("MANAGE", "Add a material to a product's bill of materials."),
      "product.updateMaterial": write("MANAGE", "Change a material on a product."),
      "product.removeMaterial": write("MANAGE", "Remove a material from a product."),
      "product.createAltGroup": write("MANAGE", "Group alternate materials for a product."),
      "product.addMaterialToAltGroup": write("MANAGE", "Add an alternate material."),
      "product.setAltGroupActive": write("MANAGE", "Pick which alternate material is in use."),
      "product.removeFromAltGroup": write("MANAGE", "Remove an alternate material."),
      "product.deleteAltGroup": write("MANAGE", "Remove an alternate group."),
      "product.updateAltGroupLabel": write("MANAGE", "Rename an alternate group."),
      "tool.list": read("List tools and molds."),
      "tool.get": read("Get one tool."),
      "tool.usage": read("How much a tool has been used."),
      "tool.create": write("MANAGE", "Create a tool or mold."),
      "tool.update": write("MANAGE", "Change a tool, including maintenance limits."),
      "tool.delete": remove("MANAGE", "Delete a tool.", "Only works when no job uses it."),
      "tool.listCavities": read("List a tool's cavities."),
      "tool.addCavity": write("MANAGE", "Add a cavity to a tool."),
      "tool.updateCavity": write("MANAGE", "Change a cavity."),
      "tool.removeCavity": write("MANAGE", "Remove a cavity."),
      "job.list": read("List jobs."),
      "job.get": read("Get one job."),
      "job.listTools": read("List a job's tools."),
      "job.listItems": read("List a job's products."),
      "job.eligibleStations": read("Which stations can run a job."),
      "job.create": write("MANAGE", "Create a job with its speed standard."),
      "job.update": write("MANAGE", "Change a job."),
      "job.delete": remove("MANAGE", "Delete a job.", "Only works when it has no products."),
      "job.addTool": write("MANAGE", "Add a tool to a job."),
      "job.removeTool": write("MANAGE", "Remove a tool from a job."),
      "job.addItem": write("MANAGE", "Add a product to a job (how many per count, with which tool and cavity)."),
      "job.updateItem": write("MANAGE", "Change a product on a job."),
      "job.removeItem": write("MANAGE", "Remove a product from a job."),
    },
  },

  downtime: {
    label: "Downtime reasons",
    description:
      "Why a station was down or slow, grouped into categories. Planned reasons (breaks, maintenance) don't count against availability.",
    dependsOn: ["plant"],
    actions: {
      "statusCategory.list": read("List downtime categories."),
      "statusCategory.get": read("Get one category."),
      "statusCategory.create": write("ADMIN", "Create a downtime category."),
      "statusCategory.update": write("ADMIN", "Rename a category."),
      "statusCategory.delete": remove("ADMIN", "Delete a category.", "Only works when no reason uses it."),
      "statusReason.list": read("List downtime reasons."),
      "statusReason.get": read("Get one reason."),
      "statusReason.create": write("ADMIN", "Create a downtime reason (planned or not, category, labels)."),
      "statusReason.update": write("ADMIN", "Change a downtime reason. labelIds replaces the whole list."),
      "statusReason.delete": write("ADMIN", "Archive a downtime reason.", "Operators can't pick it any more."),
    },
  },

  defects: {
    label: "Scrap and defect reasons",
    description: "What happens to a bad part (a disposition, like Scrap) and why (a reason).",
    dependsOn: ["plant"],
    notes: "Every plant has a protected system disposition 'Scrap'. Reasons belong to one or more dispositions.",
    actions: {
      "disposition.list": read("List dispositions."),
      "disposition.get": read("Get one disposition."),
      "disposition.create": write("ADMIN", "Create a disposition, like Rework."),
      "disposition.update": write("ADMIN", "Rename a disposition."),
      "disposition.delete": remove("ADMIN", "Delete a disposition.", "Not the system Scrap, and only when unused."),
      "dispositionReason.list": read("List defect reasons."),
      "dispositionReason.get": read("Get one reason."),
      "dispositionReason.create": write("ADMIN", "Create a defect reason for one or more dispositions."),
      "dispositionReason.update": write("ADMIN", "Change a defect reason."),
      "dispositionReason.delete": remove("ADMIN", "Delete a defect reason.", "Only when no scrap was logged with it."),
    },
  },

  team: {
    label: "Team",
    description:
      "Floor employees (operators) and their roles. Roles decide who may open and answer calls and use production modes.",
    dependsOn: ["plant"],
    notes:
      "Every plant starts with 8 roles (Operator, Supervisor, Lead, Quality, Maintenance, Contractor, Engineer, Manager). These are not login accounts; users are under Access.",
    actions: {
      "employeeRole.list": read("List team roles."),
      "employeeRole.create": write("ADMIN", "Create a team role."),
      "employeeRole.update": write("ADMIN", "Rename a team role."),
      "employeeRole.delete": remove("ADMIN", "Delete a team role.", "Calls and modes limited to it lose that limit."),
      "employee.list": read("List employees."),
      "employee.get": read("Get one employee."),
      "employee.create": write("ADMIN", "Add an employee (name, number, badge, PIN, role, contact)."),
      "employee.update": write("ADMIN", "Change an employee."),
      "employee.delete": remove("ADMIN", "Remove an employee.", "They can no longer log on at stations."),
      "employee.setSmsConsent": write(
        "ADMIN",
        "Record an employee's text message consent.",
        "This is a legal consent record; only set what the person said.",
      ),
    },
  },

  modes: {
    label: "Production modes",
    description:
      "Operating states a station can be put in, like Setup or Trial. A mode can scrap everything made, set a downtime reason, and be limited to some roles.",
    dependsOn: ["downtime", "defects", "team"],
    notes: "A mode that scraps everything needs the system Scrap disposition and a defect reason.",
    actions: {
      "productionMode.list": read("List production modes."),
      "productionMode.get": read("Get one mode."),
      "productionMode.create": write("ADMIN", "Create a production mode."),
      "productionMode.update": write("ADMIN", "Change a production mode."),
      "productionMode.archive": write("ADMIN", "Archive a production mode.", "It can't be picked any more."),
    },
  },

  calls: {
    label: "Calls and notifications",
    description:
      "Call types operators raise (like Maintenance or Quality), who may open and answer them, and groups of people to notify.",
    dependsOn: ["team"],
    actions: {
      "callDefinition.list": read("List call types."),
      "callDefinition.get": read("Get one call type."),
      "callDefinition.create": write("ADMIN", "Create a call type (name, severity, who opens and answers)."),
      "callDefinition.update": write("ADMIN", "Change a call type."),
      "callDefinition.archive": write("ADMIN", "Archive a call type.", "Operators can't raise it any more."),
      "notificationGroup.list": read("List notification groups."),
      "notificationGroup.get": read("Get one group."),
      "notificationGroup.create": write("ADMIN", "Create a notification group (members, email and/or text)."),
      "notificationGroup.update": write("ADMIN", "Change a notification group."),
      "notificationGroup.archive": write(
        "ADMIN",
        "Archive a notification group.",
        "Automations sending to it stop reaching anyone.",
      ),
      "notification.send": write(
        "MANAGE",
        "Send a message to groups or people now.",
        "Sends real email and text messages.",
      ),
    },
  },

  automations: {
    label: "Automations",
    description:
      "When something happens (a station goes down, a job changes, a call opens), check conditions and do things (notify, open a call, change a mode).",
    dependsOn: ["calls"],
    notes:
      "Read automations.getCatalog and automations.listSchemas first: they list the events, the facts you can check, and each action's inputs.",
    actions: {
      "automations.listSchemas": read("List every event and action an automation can use."),
      "automations.getCatalog": read("Get the facts and variables for an event and actions."),
      "automations.listRefOptions": read("Get picker options (stations, groups, reasons) for automation inputs."),
      "automations.list": read("List automations."),
      "automations.listRuns": read("See what an automation did recently."),
      "automations.create": write("ADMIN", "Create an automation."),
      "automations.update": write("ADMIN", "Change an automation, or turn it on or off."),
      "automations.delete": remove("ADMIN", "Delete an automation.", "It stops running."),
    },
  },

  displays: {
    label: "Terminals, boards and dashboards",
    description:
      "Operator terminals and wall boards, paired by the code they show, and the dashboard layouts boards display.",
    dependsOn: ["stations"],
    actions: {
      "display.list": read("List terminals and boards."),
      "display.claim": write("ADMIN", "Pair a terminal or board by the code on its screen."),
      "display.update": write("ADMIN", "Rename a display or point it at a workcenter or station."),
      "display.assignDashboard": write("ADMIN", "Show a dashboard on a board."),
      "display.unassignDashboard": write("ADMIN", "Stop showing a dashboard on a board."),
      "display.delete": remove(
        "ADMIN",
        "Unpair a terminal or board.",
        "The screen goes back to showing a pairing code.",
      ),
      "dashboard.list": read("List dashboards."),
      "dashboard.get": read("Get one dashboard."),
      "dashboard.create": write("MANAGE", "Create a dashboard layout."),
      "dashboard.update": write("MANAGE", "Change a dashboard."),
      "dashboard.delete": remove("MANAGE", "Delete a dashboard.", "Boards showing it go blank."),
    },
  },

  orders: {
    label: "Customers and orders",
    description: "Customers and their orders: what to make, how many, by when.",
    dependsOn: ["catalog"],
    actions: {
      "customer.list": read("List customers."),
      "customer.get": read("Get one customer."),
      "customer.create": write("MANAGE", "Create a customer."),
      "customer.update": write("MANAGE", "Rename a customer."),
      "customer.delete": remove("MANAGE", "Delete a customer.", "Only when they have no orders."),
      "order.list": read("List orders."),
      "order.get": read("Get one order."),
      "order.nextNumber": read("Get the next order number."),
      "order.create": write("MANAGE", "Create an order with its line items."),
      "order.update": write("MANAGE", "Change an order."),
      "order.addLineItem": write("MANAGE", "Add a line to an order."),
      "order.updateLineItem": write("MANAGE", "Change a line on an order."),
      "order.removeLineItem": write("MANAGE", "Remove a line from an order."),
      "order.transitionStatus": write(
        "MANAGE",
        "Complete or cancel an order.",
        "Completing takes stock; cancelling can't be undone.",
      ),
      "order.delete": remove("MANAGE", "Delete an order.", "Only open orders can be deleted."),
    },
  },

  stock: {
    label: "Stock",
    description: "On-hand stock of products and materials.",
    dependsOn: ["catalog"],
    actions: {
      "inventory.productStock": read("Get a product's stock."),
      "materialLedger.balance": read("Get a material's stock."),
      "materialLedger.create": write(
        "MANAGE",
        "Record a material receipt, write-off, transfer or opening balance.",
        "Changes stock on hand.",
      ),
      "materialLedger.adjust": write("MANAGE", "Correct a material's stock.", "Changes stock on hand."),
      "inventory.adjustStock": write("MANAGE", "Correct a product's stock.", "Changes stock on hand."),
    },
  },

  documents: {
    label: "Documents",
    description:
      "Folders of documents (setup sheets, work instructions) and which station, job, tool or product they belong to.",
    notes: "Uploading files is done in the Library; the assistant can make folders, rename, and link documents.",
    actions: {
      "document.list": read("List documents and folders."),
      "document.get": read("Get one document."),
      "document.listForTarget": read("List documents linked to a station, job, tool, product or material."),
      "document.createFolder": write("MANAGE", "Create a folder."),
      "document.update": write("MANAGE", "Rename or move a document or folder."),
      "document.link": write("MANAGE", "Link a document to a station, job, tool, product or material."),
      "document.unlink": write("MANAGE", "Unlink a document."),
      "document.delete": remove("MANAGE", "Delete a document or folder.", "Permanent, including the stored file."),
    },
  },

  access: {
    label: "Access",
    description:
      "Who can see and change what: each person's level at the plant (view, manage, admin) and per workcenter.",
    notes: "Plant admin covers every workcenter. The last plant admin can't be removed.",
    actions: {
      "bucket.list": read("Your own access."),
      "bucket.members": read("Who has access to a plant or workcenter."),
      "workspace.listMembers": read("List people in the workspace."),
      "workspace.listBuckets": read("List the plant and workcenter access groups."),
      "bucket.setAccess": write(
        "ADMIN",
        "Give a person access to a plant or workcenter at a level.",
        "Changes what someone can see and do.",
      ),
      "bucket.removeAccess": write("ADMIN", "Take away a person's access.", "Changes what someone can see and do."),
    },
  },

  integrations: {
    label: "Integrations",
    description: "Connections to other systems (ERP, webhooks) and the triggers that call them when something happens.",
    notes: "Read integration.typeCatalog first: it lists each integration type's settings.",
    actions: {
      "integration.typeCatalog": read("List integration types and their settings."),
      "integration.list": read("List integrations."),
      "integration.get": read("Get one integration."),
      "integration.triggerList": read("List integration triggers."),
      "integration.runList": read("See recent integration runs."),
      "integration.create": write("ADMIN", "Add an integration.", "Stores credentials for another system."),
      "integration.update": write("ADMIN", "Change an integration.", "May change stored credentials."),
      "integration.delete": remove("ADMIN", "Delete an integration.", "Its triggers stop."),
      "integration.triggerCreate": write("ADMIN", "Add a trigger that calls an integration on an event."),
      "integration.triggerUpdate": write("ADMIN", "Change a trigger."),
      "integration.triggerDelete": remove("ADMIN", "Delete a trigger.", "It stops calling the other system."),
      "integration.execute": write("MANAGE", "Run an integration action now.", "Calls the other system for real."),
    },
  },

  apiTokens: {
    label: "API tokens",
    description: "Read-only tokens other systems use to read plant data.",
    actions: {
      "apiToken.list": { kind: "read", level: "ACCOUNT_ADMIN", summary: "List API tokens." },
      "apiToken.create": write(
        "ADMIN",
        "Create a read-only API token.",
        "Creates a credential; its secret is shown once.",
      ),
      "apiToken.revoke": remove("ACCOUNT_ADMIN", "Revoke an API token.", "Systems using it stop working."),
    },
  },

  entities: {
    label: "Custom entities",
    description:
      "Your own kinds of records (models with fields) and their entries, for things Rockware doesn't track out of the box.",
    actions: {
      "entity.catalog.list": read("List entity models, built-in and custom."),
      "entity.model.list": read("List custom models."),
      "entity.model.get": read("Get one model with its fields."),
      "entity.model.create": write("ADMIN", "Create a custom model."),
      "entity.model.update": write("ADMIN", "Change a custom model."),
      "entity.model.delete": remove("ADMIN", "Delete a custom model.", "Deletes its entries too."),
      "entity.model.field.create": write("ADMIN", "Add a field to a model."),
      "entity.model.field.update": write("ADMIN", "Change a field."),
      "entity.model.field.delete": remove("ADMIN", "Remove a field.", "Its values are lost."),
      "entity.instance.list": read("List entries of a model."),
      "entity.instance.create": write("MANAGE", "Add an entry."),
      "entity.instance.update": write("MANAGE", "Change an entry."),
      "entity.instance.delete": remove("MANAGE", "Delete an entry.", "Permanent."),
    },
  },

  liveGraph: {
    label: "Live data graph",
    description:
      "Live values computed from machine signals and metrics (nodes, types, properties) and hooks that fire events from them. Advanced.",
    notes:
      "Read graph.introspect.manifest first: it describes every resolver and rule. Use graph.property.validate and graph.introspect.plan to check before changing.",
    actions: {
      "graph.introspect.manifest": read("How the live graph works: resolvers, expressions, hooks."),
      "graph.type.catalog": read("List graph types."),
      "graph.node.list": read("List graph nodes."),
      "graph.node.get": read("Get one node."),
      "graph.property.list": read("List a node's properties."),
      "graph.property.validate": read("Check a property before saving it."),
      "graph.hook.list": read("List hooks."),
      "graph.hook.eventCatalog": read("List the events hooks can fire."),
      "graph.introspect.plan": { kind: "read", level: "ADMIN", summary: "Dry-run a change to see its effect." },
      "graph.node.create": write("ADMIN", "Create a node."),
      "graph.node.update": write("ADMIN", "Change a node."),
      "graph.node.delete": remove("ADMIN", "Delete a node.", "Its live values and dependents stop."),
      "graph.property.create": write("ADMIN", "Add a live property."),
      "graph.property.update": write("ADMIN", "Change a live property."),
      "graph.property.delete": remove("ADMIN", "Delete a live property.", "Anything using it stops working."),
      "graph.hook.create": write("ADMIN", "Add a hook."),
      "graph.hook.update": write("ADMIN", "Change a hook."),
      "graph.hook.delete": remove("ADMIN", "Delete a hook.", "Its events stop firing."),
    },
  },
};

/** Every action by its router path, with its domain. */
export function allActions(): Array<ActionMeta & { path: string; domain: string }> {
  return Object.entries(SETUP_DOMAINS).flatMap(([domain, d]) =>
    Object.entries(d.actions).map(([path, meta]) => ({ ...meta, path, domain })),
  );
}

export function findAction(path: string): (ActionMeta & { path: string; domain: string }) | undefined {
  return allActions().find((a) => a.path === path);
}
