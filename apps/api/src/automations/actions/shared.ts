import { type ActionContext, causeOf } from "@rw/automations";

/** Actor fields every domain call from an automation carries: SYSTEM source, this automation as the ref, the chain cause. */
export function systemSource(ctx: ActionContext) {
  return {
    source: "SYSTEM" as const,
    sourceType: "automation",
    sourceRef: ctx.automation.id,
    cause: causeOf(ctx.event),
  };
}

/** The station an action targets: an explicit input, else the station the triggering event was about. */
export function stationFrom(inputs: Record<string, unknown>, ctx: ActionContext): string {
  const stationId = String(inputs.stationId ?? "").trim() || String(ctx.event.payload.stationId ?? "");
  if (!stationId) {
    throw new Error(`automation "${ctx.automation.label}": no stationId input and the event carries none`);
  }
  return stationId;
}

/** Turn a service `{ error, code }` result into a thrown error so the run is recorded FAILED. */
export function unwrapService<T>(result: T | { error: string; code: string }): T {
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(`${result.code}: ${result.error}`);
  }
  return result;
}

export const STATION_INPUT = {
  type: "string" as const,
  title: "Station",
  description: "Station id or {{event.payload.stationId}}. Blank = the station the event is about.",
};
