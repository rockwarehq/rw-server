import { coreLivestoreCatalog } from "./core.js";
import { immLivestoreCatalog } from "./imm.js";

export const LIVESTORE_EVENT_STREAM = "RW_LIVESTORE_EVENTS";
export const LIVESTORE_EVENT_SUBJECT_PREFIX = "livestore.events";
export const LIVESTORE_EVENT_SUBJECT_FILTER = `${LIVESTORE_EVENT_SUBJECT_PREFIX}.>`;

const EVENT_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const VERSION_PATTERN = /^[0-9]+$/;

export type LivestoreHookContextFieldType = "string" | "number" | "boolean" | "object";
export type LivestoreHookContextSourceType = "property";

export interface LivestoreHookContextFieldSchema {
  label: string;
  type: LivestoreHookContextFieldType;
  required: boolean;
  description?: string;
  sourceTypes: readonly LivestoreHookContextSourceType[];
}

export interface LivestoreHookEventSchema {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  integration: string;
  description: string;
  contextFields: Record<string, LivestoreHookContextFieldSchema>;
}

// Composed from the catalog fragments; order (core, then imm) matches the
// original inline literal so downstream consumers see an identical catalog.
export const LIVESTORE_HOOK_EVENT_CATALOG = [
  ...coreLivestoreCatalog.hookEvents,
  ...immLivestoreCatalog.hookEvents,
] as const satisfies readonly LivestoreHookEventSchema[];

export interface LivestoreHookEventContextMetadata {
  propertyId: string;
  quality: string;
  timestamp: number;
}

export interface LivestoreHookEvent {
  id: string;
  namespace: string;
  name: string;
  type: string;
  version: string;
  siteId: string;
  hookId: string;
  hookName: string;
  propertyId: string;
  emittedAt: string;
  previous: unknown;
  current: unknown;
  payload: Record<string, unknown>;
  context: Record<string, LivestoreHookEventContextMetadata>;
}

export function normalizeLivestoreEventToken(value: string): string {
  if (containsNatsBlockedCharacter(value)) {
    throw new Error("LiveStore event token contains a NATS wildcard or control character");
  }
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[./\\\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!token) throw new Error("LiveStore event token must not be empty");
  if (token.startsWith("$")) throw new Error("LiveStore event token must not use a NATS system token");
  if (!EVENT_TOKEN_PATTERN.test(token)) throw new Error("LiveStore event token must be NATS-safe");
  return token;
}

function containsNatsBlockedCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "*" || char === ">" || code < 32 || code === 127) return true;
  }
  return false;
}

export function normalizeLivestoreEventVersion(value: string): string {
  const version = value.trim().replace(/^v/i, "");
  if (!VERSION_PATTERN.test(version)) throw new Error("LiveStore event version must be numeric");
  return version;
}

export function livestoreEventType(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

export function deriveLivestoreEventSubject(siteId: string, namespace: string, name: string, version: string): string {
  const siteToken = normalizeLivestoreEventToken(siteId);
  const namespaceToken = normalizeLivestoreEventToken(namespace);
  const nameToken = normalizeLivestoreEventToken(name);
  const versionToken = normalizeLivestoreEventVersion(version);
  if (!siteToken) throw new Error("siteId must produce a non-empty LiveStore event subject token");
  return `${LIVESTORE_EVENT_SUBJECT_PREFIX}.${siteToken}.${namespaceToken}.${nameToken}.v${versionToken}`;
}

export function isKnownLivestoreHookEvent(namespace: string, name: string, version: string): boolean {
  return Boolean(getLivestoreHookEventSchema(namespace, name, version));
}

export function getLivestoreHookEventSchema(
  namespace: string,
  name: string,
  version: string,
): LivestoreHookEventSchema | null {
  const eventNamespace = normalizeLivestoreEventToken(namespace);
  const eventName = normalizeLivestoreEventToken(name);
  const eventVersion = normalizeLivestoreEventVersion(version);
  return (
    LIVESTORE_HOOK_EVENT_CATALOG.find(
      (event) => event.namespace === eventNamespace && event.name === eventName && event.version === eventVersion,
    ) ?? null
  );
}

for (const event of LIVESTORE_HOOK_EVENT_CATALOG) {
  normalizeLivestoreEventToken(event.namespace);
  normalizeLivestoreEventToken(event.name);
  normalizeLivestoreEventVersion(event.version);
}
