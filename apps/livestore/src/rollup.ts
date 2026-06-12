import { usableValue, worse, type Quality, type RollupResolverConfig, type ValueEnvelope } from "./types.js";

// Evaluates a rollup resolver by aggregating the values of its children
// Checks quality and values
export function evaluateRollup(resolver: RollupResolverConfig, children: ValueEnvelope[]): ValueEnvelope {
  const total = children.length;
  let present = 0;
  let worstQuality: Quality = "good";
  let acc = resolver.aggregation === "min" ? Infinity : resolver.aggregation === "max" ? -Infinity : 0;
  let count = 0;
  let latestTs = 0;

  for (const child of children) {
    const v = usableValue(child);
    if (v === null) {
      worstQuality = worse(worstQuality, "uncertain");
      continue;
    }
    present += 1;
    worstQuality = worse(worstQuality, child.quality);
    if (child.timestamp > latestTs) latestTs = child.timestamp;
    switch (resolver.aggregation) {
      case "sum":
        acc += v;
        break;
      case "count":
        break;
      case "min":
        acc = Math.min(acc, v);
        break;
      case "max":
        acc = Math.max(acc, v);
        break;
      case "avg":
        acc += v;
        count += 1;
        break;
    }
  }

  let value: number | null;
  if (resolver.aggregation === "count") value = total;
  else if (resolver.aggregation === "avg") value = count > 0 ? acc / count : null;
  else value = present > 0 ? acc : null;

  const quality: Quality =
    present === 0 && resolver.aggregation !== "count"
      ? "bad"
      : present < total
        ? worse(worstQuality, "uncertain")
        : worstQuality;

  return {
    value,
    quality,
    timestamp: latestTs || Date.now(),
    context: { aggregation: resolver.aggregation, childCount: total, present },
  };
}
