import type { AnyProcedure } from "@orpc/server";
import { z } from "zod";
import { findAction } from "./manifest.js";

// Pairs the setup catalog (manifest.ts) with the live router: each action's
// real procedure and its input rules as JSON Schema, read from the procedure
// itself so the assistant always sees what the server actually accepts.
//
// The router is imported lazily: rpc/index.ts imports the insights router,
// which uses this file, so a static import would go in a circle.

type RouterNode = Record<string, unknown>;

let routerPromise: Promise<RouterNode> | undefined;
async function loadRouter(): Promise<RouterNode> {
  routerPromise ??= import("../rpc/index.js").then((m) => m.router as unknown as RouterNode);
  return routerPromise;
}

/** The procedure at a dotted router path, or undefined. */
export async function procedureAt(path: string): Promise<AnyProcedure | undefined> {
  let node: unknown = await loadRouter();
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as RouterNode)[key];
  }
  return node && typeof node === "object" && "~orpc" in node ? (node as AnyProcedure) : undefined;
}

/** A procedure's input schema (zod), if it has one. */
export async function inputSchemaAt(path: string): Promise<z.ZodType | undefined> {
  const proc = await procedureAt(path);
  const schema = (proc as unknown as { "~orpc": { inputSchema?: unknown } } | undefined)?.["~orpc"].inputSchema;
  return schema instanceof z.ZodType ? schema : undefined;
}

const jsonSchemaCache = new Map<string, unknown>();

/**
 * A procedure's input rules as JSON Schema, for the assistant to read.
 * Recursive or unusual schemas that can't be turned into JSON Schema come
 * back as a note instead of failing.
 */
export async function inputJsonSchema(path: string): Promise<unknown> {
  if (jsonSchemaCache.has(path)) return jsonSchemaCache.get(path);
  const schema = await inputSchemaAt(path);
  let json: unknown;
  if (!schema) json = { note: "No input." };
  else {
    try {
      json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", cycles: "ref" });
    } catch {
      json = {
        note: "These inputs can't be described automatically; read the notes and try, the server will say what's wrong.",
      };
    }
  }
  jsonSchemaCache.set(path, json);
  return json;
}

/** An action from the setup catalog, with its procedure. Undefined when unknown or not on the router. */
export async function resolveAction(path: string) {
  const meta = findAction(path);
  if (!meta) return undefined;
  const proc = await procedureAt(path);
  return proc ? { ...meta, proc } : undefined;
}
