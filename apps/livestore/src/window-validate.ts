import { isAggregation, type WindowResolverConfig } from "./types.js";

const MIN_WINDOW_MS = 1000;

// Save/load-time validation of the config for resolver type window.
export function validateWindowResolver(
  config: WindowResolverConfig,
  getProperty: (id: string) => { resolverType: string } | null,
): string[] {
  const errors: string[] = [];

  const source = getProperty(config.sourcePropertyId);
  if (!source) {
    errors.push(`source property "${config.sourcePropertyId}" does not exist`);
  } else if (source.resolverType === "window") {
    errors.push("source property is a window — chained windows are not allowed in v1 (§17.10)");
  }

  if (config.kind === "tumbling") {
    if (typeof config.windowMs !== "number" || !Number.isFinite(config.windowMs) || config.windowMs < MIN_WINDOW_MS) {
      errors.push(`windowMs must be a finite number >= ${MIN_WINDOW_MS}`);
    }
    if (!isAggregation(config.aggregation)) {
      errors.push("aggregation must be one of sum, avg, count, min, max");
    }
    if (config.alignToMs !== undefined && !Number.isFinite(config.alignToMs)) {
      errors.push("alignToMs must be a finite number");
    }
  } else {
    if (typeof config.alpha !== "number" || !(config.alpha > 0 && config.alpha <= 1)) {
      errors.push("alpha must be a number in (0, 1]");
    }
  }

  return errors;
}
