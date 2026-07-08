import { IMM_GRAPH_TYPE_NAMESPACE, type LivestoreGraphTypeSchema } from "../catalog/graph-types.js";
import { describe, expect, it } from "vitest";

const typeByKey = (key: string): LivestoreGraphTypeSchema => {
  const type = IMM_GRAPH_TYPE_NAMESPACE.types.find((t) => t.key === key);
  if (!type) throw new Error(`missing graph type: ${key}`);
  return type;
};

const resolverFor = (type: LivestoreGraphTypeSchema, fieldKey: string): Record<string, unknown> => {
  const field = type.fields.find((f) => f.key === fieldKey);
  if (!field) throw new Error(`missing field ${fieldKey} on ${type.key}`);
  return field.resolver;
};

const fieldRefKeys = (expression: string): string[] =>
  [...expression.matchAll(/\$field\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);

describe("IMM graph type namespace", () => {
  it("defines station, workcenter, and site", () => {
    expect(IMM_GRAPH_TYPE_NAMESPACE.types.map((t) => t.key).sort()).toEqual(["site", "station", "workcenter"]);
  });

  it("station metric entityType matches the rollup childKind used by workcenter", () => {
    const station = typeByKey("station");
    const workcenter = typeByKey("workcenter");
    expect(resolverFor(station, "runSeconds").entityType).toBe("Station");
    expect(resolverFor(workcenter, "runSeconds").childKind).toBe("Station");
  });

  it("workcenter rolls up stations and site rolls up workcenters", () => {
    const wc = resolverFor(typeByKey("workcenter"), "totalItems");
    expect(wc).toMatchObject({
      type: "rollup",
      childKind: "Station",
      relation: "stations",
      childProperty: "totalItems",
      aggregation: "sum",
      parent: { model: "Workcenter", id: "$input.workcenterId" },
    });

    const site = resolverFor(typeByKey("site"), "totalItems");
    expect(site).toMatchObject({
      type: "rollup",
      childKind: "Workcenter",
      relation: "workcenters",
      childProperty: "totalItems",
      aggregation: "sum",
      parent: { model: "Site", id: "$input.siteId" },
    });
  });

  it("every derived expression references only fields present on the same type", () => {
    for (const key of ["station", "workcenter", "site"]) {
      const type = typeByKey(key);
      const fieldKeys = new Set(type.fields.map((f) => f.key));
      for (const field of type.fields) {
        if (field.resolverType !== "expr") continue;
        const expression = field.resolver.expression as string;
        for (const ref of fieldRefKeys(expression)) {
          expect(fieldKeys.has(ref), `${key}.${field.key} references missing field ${ref}`).toBe(true);
        }
      }
    }
  });
});
