import { stationStateSeries } from "./station-state.js";
import type { SeriesDefinition } from "./types.js";

// Series registry (ADR 0008 §6): the RPC verbs are generic dispatchers and
// never grow per-type code. Adding a series type = one definition file, one
// entry here, and one member in the RPC selector union (the union is what
// types the published rpc-client).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const definitions = new Map<string, SeriesDefinition<any, any>>([[stationStateSeries.seriesType, stationStateSeries]]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSeries(seriesType: string): SeriesDefinition<any, any> | undefined {
  return definitions.get(seriesType);
}
