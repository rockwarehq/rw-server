import { usableValue, worse, type Quality, type RollupResolverConfig, type ValueEnvelope } from "./types.js";

export interface RollupChild {
  current: ValueEnvelope;
  weight?: ValueEnvelope;
}

// Evaluates a rollup resolver by aggregating the values of its children
// Checks quality and values
export function evaluateRollup(resolver: RollupResolverConfig, children: RollupChild[]): ValueEnvelope {
  // weightBy applies to avg only 
  const weighted = resolver.aggregation === "avg" && Boolean(resolver.weightBy);
  const total = children.length;
  let present = 0;
  let worstQuality: Quality = "good";
  let acc = resolver.aggregation === "min" ? Infinity : resolver.aggregation === "max" ? -Infinity : 0;
  let count = 0;
  let weightSum = 0;
  let weightedSum = 0;
  let latestTs = 0;

  for (const child of children) {
    const v = usableValue(child.current);
    if (v === null) {
      worstQuality = worse(worstQuality, "uncertain");
      continue;
    }
    present += 1;
    worstQuality = worse(worstQuality, child.current.quality);
    if (child.current.timestamp > latestTs) latestTs = child.current.timestamp;
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
        if (weighted) {
          // missing/zero weight excludes the child and degrades quality 
          const w = child.weight ? usableValue(child.weight) : null;
          if (w !== null && w > 0) {
            weightedSum += v * w;
            weightSum += w;
          } else {
            worstQuality = worse(worstQuality, "uncertain");
          }
        } else {
          acc += v;
          count += 1;
        }
        break;
    }
  }

  let value: number | null;
  if (resolver.aggregation === "count") value = total;
  else if (weighted) value = weightSum > 0 ? weightedSum / weightSum : null;
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
