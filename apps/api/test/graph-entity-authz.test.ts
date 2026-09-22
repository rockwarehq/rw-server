import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import { createApiToken } from "@rw/auth/api-tokens";
import { hashPassword } from "@rw/auth/password";
import { createAccessToken } from "@rw/auth/verify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const PASSWORD = "graph-authz-password-1";
const ROLES = ["Plant Admin", "Plant Engineer", "Planner", "Plant Member"] as const;
type Role = (typeof ROLES)[number];
type Directory = { data: Array<{ id: string; values?: { parentId?: string | null }; properties?: Array<{ id: string }> }>; total: number };
type GraphDefinition = {
  id: string;
  typeContext: Record<string, unknown>;
  facets: Record<string, unknown>;
  properties: Array<{ id: string; resolver: Record<string, unknown> }>;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("graph/entity/integration authorization (Tier 2)", () => {
  let server: TestServer;
  let siteA: string;
  let siteB: string;
  let memberWorkcenter: string;
  let foreignWorkcenter: string;
  let ownStation: string;
  let foreignStation: string;
  let productId: string;
  let customerId: string;
  let ownNode: string;
  let foreignNode: string;
  let plantNode: string;
  let productNode: string;
  let foreignProperty: string;
  let displayToken: string;
  let appToken: string;
  let appTokenId: string;
  let configurationToken: string;
  let configurationRoleId: string;
  const tokens = {} as Record<Role, string>;
  const emails: string[] = [];

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const { workspaceId } = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { workspaceId: true } });
    const suffix = randomUUID();
    siteA = (await prisma.site.create({ data: { workspaceId, name: `GraphAuthZ A ${suffix}` } })).id;
    siteB = (await prisma.site.create({ data: { workspaceId, name: `GraphAuthZ B ${suffix}` } })).id;
    foreignWorkcenter = (await prisma.workcenter.create({ data: { siteId: siteA, name: "Foreign WC" } })).id;
    memberWorkcenter = (await prisma.workcenter.create({ data: { siteId: siteA, name: "Assigned WC", parentId: foreignWorkcenter } })).id;
    ownStation = (await prisma.station.create({ data: { siteId: siteA, workcenterId: memberWorkcenter, name: "Own Station" } })).id;
    foreignStation = (await prisma.station.create({ data: { siteId: siteA, workcenterId: foreignWorkcenter, name: "Foreign Station" } })).id;
    productId = (await prisma.product.create({ data: { siteId: siteA } })).id;
    customerId = (await prisma.customer.create({ data: { siteId: siteA, name: "Planning Customer" } })).id;

    const passwordHash = await hashPassword(PASSWORD);
    const configurationRole = await prisma.role.create({ data: {
      workspaceId, name: `Graph Configuration Editor ${suffix}`, scope: "SITE", permissions: ["configuration:write"],
    } });
    configurationRoleId = configurationRole.id;
    const configurationEmail = `graph-config-${suffix}@test.local`;
    emails.push(configurationEmail);
    const configurationUser = await prisma.user.create({ data: { email: configurationEmail, passwordHash, status: "ACTIVE" } });
    const configurationMembership = await prisma.workspaceMembership.create({ data: { userId: configurationUser.id, workspaceId } });
    await prisma.roleAssignment.create({ data: { membershipId: configurationMembership.id, roleId: configurationRole.id, siteId: siteA } });
    configurationToken = (await loginAs(server, configurationEmail, PASSWORD)).accessToken;
    for (const name of ROLES) {
      const role = await prisma.role.findUniqueOrThrow({ where: { workspaceId_name_scope: { workspaceId, name, scope: "SITE" } } });
      const email = `graph-${name.replaceAll(" ", "-").toLowerCase()}-${suffix}@test.local`;
      emails.push(email);
      const user = await prisma.user.create({ data: { email, passwordHash, firstName: "GraphAuthZ", status: "ACTIVE" } });
      const membership = await prisma.workspaceMembership.create({ data: { userId: user.id, workspaceId } });
      await prisma.roleAssignment.create({ data: { membershipId: membership.id, roleId: role.id, siteId: siteA } });
      if (name === "Plant Member") await prisma.workcenterGrant.create({
        data: { membershipId: membership.id, workcenterId: memberWorkcenter, access: "READ" },
      });
      tokens[name] = (await loginAs(server, email, PASSWORD)).accessToken;
    }

    for (const [name, stationId] of [["Own", ownStation], ["Foreign", foreignStation]]) {
      const node = await prisma.graphNode.create({ data: {
        siteId: siteA, name, typeRef: "@imm/station", typeContext: { stationId },
        facets: { stationId, workcenterId: stationId === ownStation ? memberWorkcenter : foreignWorkcenter },
        properties: { create: [
          { name: "status", resolverType: "entity", resolver: { type: "entity", entityType: "imm.station", entityId: stationId, path: "status" } },
          { name: "quantityUnit", resolverType: "entity", resolver: { type: "entity", entityType: "imm.station", entityId: stationId, path: "currentVersion.quantityUnit" } },
        ] },
      }, include: { properties: true } });
      if (stationId === ownStation) ownNode = node.id;
      else { foreignNode = node.id; foreignProperty = node.properties[0].id; }
    }
    plantNode = (await prisma.graphNode.create({ data: {
      siteId: siteA, name: "Plant aggregate", typeRef: "@imm/site", typeContext: { siteId: siteA },
      properties: { create: { name: "total", resolverType: "rollup", resolver: {
        type: "rollup", parent: { model: "Site", id: siteA }, childKind: "Workcenter", relation: "workcenters", childProperty: "totalCycles", aggregation: "sum",
      } } },
    } })).id;
    productNode = (await prisma.graphNode.create({ data: {
      siteId: siteA, name: "Shared product", properties: { create: { name: "name", resolverType: "entity",
        resolver: { type: "entity", entityType: "imm.product", entityId: productId, path: "currentVersion.name" } } },
    } })).id;
    const display = await prisma.display.create({ data: { siteId: siteA, status: "CLAIMED", name: "No employee display" } });
    displayToken = createAccessToken({ principal: "DISPLAY", displayId: display.id, workspaceId, siteId: siteA });
    const app = await createApiToken({ workspaceId, siteId: siteA, name: "Graph read test" });
    if ("error" in app) throw new Error(app.error);
    appToken = app.token;
    appTokenId = app.id;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    if (configurationRoleId) await prisma.role.delete({ where: { id: configurationRoleId } });
    if (siteA) {
      await prisma.apiToken.deleteMany({ where: { siteId: siteA } });
      await prisma.display.deleteMany({ where: { siteId: siteA } });
      await prisma.graphNode.deleteMany({ where: { siteId: siteA } });
      await prisma.graphNodeType.deleteMany({ where: { siteId: siteA } });
      await prisma.objectSchema.deleteMany({ where: { siteId: siteA } });
      await prisma.customer.deleteMany({ where: { siteId: siteA } });
      await prisma.product.deleteMany({ where: { siteId: siteA } });
      await prisma.station.deleteMany({ where: { siteId: siteA } });
      await prisma.workcenter.deleteMany({ where: { siteId: siteA } });
      await prisma.site.delete({ where: { id: siteA } });
    }
    if (siteB) await prisma.site.delete({ where: { id: siteB } });
    await server?.close();
  });

  it("Plant Engineer retains whole-plant published data and native station reads", async () => {
    const response = await rpcCall(server, "graph/node/list", { siteId: siteA }, tokens["Plant Engineer"]);
    expect(response.statusCode).toBe(200);
    expect((response.json as Directory).data.map((node) => node.id).sort()).toEqual([ownNode, foreignNode, plantNode, productNode].sort());
    expect((response.json as Directory).data.find((node) => node.id === ownNode)?.properties).toHaveLength(2);
    const query = await rpcCall(server, "graph/node/query", { siteId: siteA, facets: { workcenterId: foreignWorkcenter } }, tokens["Plant Engineer"]);
    expect(query.statusCode).toBe(200);
    expect((query.json as Directory).data.map((node) => node.id)).toEqual([foreignNode]);
    const stations = await rpcCall(server, "entity/instance/list", { key: "imm.station" }, tokens["Plant Engineer"]);
    expect(stations.statusCode).toBe(200);
    expect((stations.json as Directory).data.map((station) => station.id).sort()).toEqual([ownStation, foreignStation].sort());
  });

  it("members see only assigned WC production, including native instance filtering and parent pointers", async () => {
    const token = tokens["Plant Member"];
    const nodes = await rpcCall(server, "graph/node/list", { siteId: siteA }, token);
    expect(nodes.statusCode).toBe(200);
    expect((nodes.json as Directory).data.map((node) => node.id).sort()).toEqual([ownNode, productNode].sort());
    const stations = await rpcCall(server, "entity/instance/list", { key: "imm.station" }, token);
    expect(stations.statusCode).toBe(200);
    expect((stations.json as Directory).data.map((station) => station.id)).toEqual([ownStation]);
    const filtered = await rpcCall(server, "entity/instance/list", { key: "imm.station", name: "Foreign" }, token);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json).toMatchObject({ data: [], total: 0 });
    const workcenters = await rpcCall(server, "entity/instance/list", { key: "imm.workcenter" }, token);
    expect(workcenters.statusCode).toBe(200);
    expect((workcenters.json as Directory).data).toMatchObject([{ id: memberWorkcenter, values: { parentId: null } }]);
    expect((await rpcCall(server, "graph/property/get", { id: foreignProperty }, token)).statusCode).toBe(404);
    expect((await rpcCall(server, "graph/node/get", { id: foreignNode }, token)).statusCode).toBe(404);
  });

  it("Planner gets planning and supporting references, never production or employee profiles", async () => {
    const token = tokens.Planner;
    for (const [key, id] of [["imm.product", productId], ["imm.customer", customerId]]) {
      const response = await rpcCall(server, "entity/instance/list", { key }, token);
      expect(response.statusCode).toBe(200);
      expect((response.json as Directory).data.map((row) => row.id)).toEqual([id]);
    }
    for (const key of ["imm.station", "imm.workcenter", "imm.employee"]) {
      expect((await rpcCall(server, "entity/instance/list", { key }, token)).statusCode).toBe(403);
    }
    const graph = await rpcCall(server, "graph/node/list", { siteId: siteA }, token);
    expect(graph.statusCode).toBe(200);
    expect((graph.json as Directory).data.map((node) => node.id)).toEqual([productNode]);
  });

  it("configuration and employee-profile permissions remain separate from published production reads", async () => {
    for (const role of ["Planner", "Plant Member"] as const) {
      expect((await rpcCall(server, "entity/model/list", {}, tokens[role])).statusCode).toBe(403);
      expect((await rpcCall(server, "graph/type/list", { siteId: siteA }, tokens[role])).statusCode).toBe(403);
      expect((await rpcCall(server, "graph/node/create", { siteId: siteA, name: "denied" }, tokens[role])).statusCode).toBe(403);
    }
    expect((await rpcCall(server, "entity/model/list", {}, tokens["Plant Engineer"])).statusCode).toBe(200);
    expect((await rpcCall(server, "entity/instance/list", { key: "imm.employee" }, tokens["Plant Engineer"])).statusCode).toBe(403);
    expect((await rpcCall(server, "entity/instance/list", { key: "imm.employee" }, tokens["Plant Admin"])).statusCode).toBe(200);
  });

  it("configuration writes and integrations use the engineer's granted site", async () => {
    const token = tokens["Plant Engineer"];
    expect((await rpcCall(server, "graph/node/create", { siteId: siteA, name: "Engineer config" }, token)).statusCode).toBe(200);
    expect((await rpcCall(server, "graph/node/create", { siteId: siteB, name: "denied" }, token)).statusCode).toBe(403);
    expect((await rpcCall(server, "integration/list", { siteId: siteA }, token)).statusCode).toBe(200);
    expect((await rpcCall(server, "integration/delete", { id: randomUUID(), siteId: siteA }, token)).statusCode).toBe(404);
    expect((await rpcCall(server, "graph/node/get", { id: randomUUID() }, token)).statusCode).toBe(404);
  });

  it("DISPLAY without an employee and explicit graph:read APP keep own-site published/picker access", async () => {
    for (const token of [displayToken, appToken]) {
      const response = await rpcCall(server, "graph/node/list", { siteId: siteA }, token);
      expect(response.statusCode).toBe(200);
      expect((response.json as Directory).data.map((node) => node.id)).toEqual(expect.arrayContaining([ownNode, foreignNode, plantNode]));
      expect((await rpcCall(server, "graph/type/catalog", { siteId: siteA }, token)).statusCode).toBe(200);
      const picker = await rpcCall(server, "graph/node/query", { siteId: siteA, facets: { workcenterId: foreignWorkcenter } }, token);
      expect(picker.statusCode).toBe(200);
      expect((picker.json as Directory).data.map((node) => node.id)).toEqual([foreignNode]);
      expect((await rpcCall(server, "graph/node/list", { siteId: siteB }, token)).statusCode).toBe(403);
      expect((await rpcCall(server, "graph/node/create", { siteId: siteA, name: "device-denied" }, token)).statusCode).toBe(401);
    }
  });

  it("APP requires the explicit graph scope rather than a customer production permission", async () => {
    await prisma.apiToken.update({ where: { id: appTokenId }, data: { scopes: ["production:read"] } });
    expect((await rpcCall(server, "graph/node/list", { siteId: siteA }, appToken)).statusCode).toBe(403);
    expect((await rpcCall(server, "graph/introspect/manifest", {}, appToken)).statusCode).toBe(403);
  });

  async function createCustomDefinition(token: string) {
    const key = `editor_${randomUUID().replaceAll("-", "_")}`;
    const type = await rpcCall(server, "graph/type/create", {
      siteId: siteA, key, label: "Editor compatibility type",
      inputs: [{ key: "station", label: "Station", valueType: "string", required: true }],
      facets: [{ key: "cell_name", label: "Cell name", valueType: "string", resolverType: "entity",
        resolver: { type: "entity", entityRef: { key: "imm.station", id: ownStation }, path: "name" } }],
      fields: [{ key: "status", label: "Status", valueType: "string", resolverType: "entity",
        resolver: { type: "entity", entityType: "imm.station", entityId: "$input.station", path: "status" } }],
    }, token);
    expect(type.statusCode, JSON.stringify(type.json)).toBe(200);
    const context = { station: ownStation, editor: { layout: "grid", columns: 3 }, customLabel: "Preserve me" };
    const created = await rpcCall(server, "graph/node/create", {
      siteId: siteA, name: key, typeRef: key, typeContext: context, materializeTypeFields: true,
    }, token);
    expect(created.statusCode, JSON.stringify(created.json)).toBe(200);
    return { node: created.json as GraphDefinition, context };
  }

  it("engineering node create/update/get/query and snapshots preserve validated custom definition metadata", async () => {
    const token = tokens["Plant Engineer"];
    const { node, context } = await createCustomDefinition(token);
    expect(node).toMatchObject({ typeContext: context, facets: { cell_name: "Own Station" },
      properties: [{ resolver: { entityType: "imm.station", entityId: ownStation, path: "status" } }] });
    const nextContext = { ...context, station: foreignStation, customLabel: "Edited" };
    const updated = await rpcCall(server, "graph/node/update", { id: node.id, typeContext: nextContext }, token);
    expect(updated.statusCode).toBe(200);
    expect(updated.json).toMatchObject({ typeContext: nextContext, facets: { cell_name: "Own Station" },
      properties: [{ resolver: { entityId: foreignStation } }] });
    const fetched = await rpcCall(server, "graph/node/get", { id: node.id }, token);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json).toMatchObject({ typeContext: nextContext, facets: { cell_name: "Own Station" } });
    const query = await rpcCall(server, "graph/node/query", { siteId: siteA, facets: { cell_name: "Own Station" } }, token);
    expect(query.statusCode).toBe(200);
    expect((query.json as Directory).data.map((row) => row.id)).toEqual([node.id]);
    const snapshot = await rpcCall(server, "graph/introspect/snapshot", { siteId: siteA }, token);
    expect(snapshot.statusCode).toBe(200);
    expect((snapshot.json as { nodes: GraphDefinition[] }).nodes.find((row) => row.id === node.id))
      .toMatchObject({ typeContext: nextContext, facets: { cell_name: "Own Station" } });
    const member = await rpcCall(server, "graph/node/get", { id: node.id }, tokens["Plant Member"]);
    expect(member.statusCode).toBe(404);
  });

  it("configuration-only editors keep editable metadata, with denied materialized/live values null", async () => {
    const { node, context } = await createCustomDefinition(configurationToken);
    expect(node).toMatchObject({ typeContext: context, facets: { cell_name: null }, properties: [{ resolver: { entityId: ownStation } }] });
    const updated = await rpcCall(server, "graph/node/update", { id: node.id, typeContext: { ...context, station: foreignStation } }, configurationToken);
    expect(updated.statusCode).toBe(200);
    expect(updated.json).toMatchObject({ typeContext: { ...context, station: foreignStation }, facets: { cell_name: null },
      properties: [{ resolver: { entityId: foreignStation } }] });
    const propertyId = (updated.json as GraphDefinition).properties[0].id;
    const property = await rpcCall(server, "graph/property/get", { id: propertyId }, configurationToken);
    expect(property.statusCode).toBe(200);
    expect(property.json).toMatchObject({ resolver: { entityId: foreignStation },
      node: { typeContext: { ...context, station: foreignStation }, facets: { cell_name: null } } });
    const listed = await rpcCall(server, "graph/property/list", { nodeId: node.id }, configurationToken);
    expect(listed.statusCode).toBe(200);
    expect((listed.json as Directory).data.map((row) => row.id)).toEqual([propertyId]);
    const explanation = await rpcCall(server, "graph/introspect/explain", { id: propertyId }, configurationToken);
    expect(explanation.statusCode).toBe(200);
    expect(explanation.json).toMatchObject({ property: { id: propertyId, resolver: { entityId: foreignStation } }, current: { envelope: null, valueAvailable: false } });
    const query = await rpcCall(server, "graph/node/query", { siteId: siteA, facets: { cell_name: "Own Station" } }, configurationToken);
    expect(query.statusCode).toBe(200);
    expect(query.json).toMatchObject({ data: [], total: 0 });
    const snapshot = await rpcCall(server, "graph/introspect/snapshot", { siteId: siteA }, configurationToken);
    expect(snapshot.statusCode).toBe(200);
    expect((snapshot.json as { nodes: GraphDefinition[] }).nodes.find((row) => row.id === node.id))
      .toMatchObject({ typeContext: { ...context, station: foreignStation }, facets: { cell_name: null } });
  });
});
