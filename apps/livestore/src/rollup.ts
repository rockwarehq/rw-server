import { worse, type Quality, type RollupResolverConfig, type ValueEnvelope } from "./types.js";

// Aggregate a rollup's child values into one envelope (spec §18.4/§18.5). Children
// is the full child slot list (including not-yet-reported ones) so coverage can be
// reported. A child that is bad/missing/non-numeric is excluded and drops quality
// to uncertain; partial coverage is also uncertain; otherwise worst child quality.
// weightBy is not yet supported (avg is unweighted for now) — see §18.2.
export function evaluateRollup(resolver: RollupResolverConfig, children: ValueEnvelope[]): ValueEnvelope {
  const total = children.length;
  let present = 0;
  let worstQuality: Quality = "good";
  let acc = resolver.aggregation === "min" ? Infinity : resolver.aggregation === "max" ? -Infinity : 0;
  let count = 0;
  let latestTs = 0;

  for (const child of children) {
    if (child.quality === "bad" || child.value === null || child.value === undefined) {
      worstQuality = worse(worstQuality, "uncertain");
      continue;
    }
    const v = Number(child.value);
    if (!Number.isFinite(v)) {
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
