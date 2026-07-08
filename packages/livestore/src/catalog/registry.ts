import type { LivestoreHookEventSchema } from "./events.js";
import type { LivestoreGraphTypeNamespaceSchema } from "./graph-types.js";

// A fragment contributes one integration's slice of the Livestore catalog
// (hook event schemas, graph type namespaces). Fragments merge in order, so
// the composed catalog preserves each fragment's declaration order.

export interface LivestoreCatalogFragment {
  readonly hookEvents: readonly LivestoreHookEventSchema[];
  readonly graphTypeNamespaces: readonly LivestoreGraphTypeNamespaceSchema[];
}

export interface LivestoreCatalog {
  readonly hookEvents: readonly LivestoreHookEventSchema[];
  readonly graphTypeNamespaces: readonly LivestoreGraphTypeNamespaceSchema[];
}

export function createLivestoreCatalog(fragments: readonly LivestoreCatalogFragment[]): LivestoreCatalog {
  return {
    hookEvents: fragments.flatMap((fragment) => fragment.hookEvents),
    graphTypeNamespaces: fragments.flatMap((fragment) => fragment.graphTypeNamespaces),
  };
}
