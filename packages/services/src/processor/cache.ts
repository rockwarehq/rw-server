import { processorConfig } from "../config.js";

export type StationEventMutationOperation = "create" | "update" | "toggle" | "delete";

export interface NotifyStationEventCacheRefreshInput {
  workspaceId: string;
  stationId: string;
  eventId: string;
  operation: StationEventMutationOperation;
}

interface StationEventCacheRefreshPayload {
  entity: "station_event";
  operation: StationEventMutationOperation;
  workspaceId: string;
  stationId: string;
  eventId: string;
  occurredAt: string;
}

export async function notifyStationEventCacheRefresh(input: NotifyStationEventCacheRefreshInput) {
  const { cacheRefreshUrl, cacheRefreshSecret, cacheRefreshTimeoutMs } = processorConfig;

  if (!cacheRefreshUrl) {
    return;
  }

  const payload: StationEventCacheRefreshPayload = {
    entity: "station_event",
    operation: input.operation,
    workspaceId: input.workspaceId,
    stationId: input.stationId,
    eventId: input.eventId,
    occurredAt: new Date().toISOString(),
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (cacheRefreshSecret) {
    headers.authorization = `Processor ${cacheRefreshSecret}`;
  }

  try {
    const response = await fetch(cacheRefreshUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cacheRefreshTimeoutMs),
    });

    if (!response.ok) {
      console.error("[PROCESSOR] Cache refresh request failed", {
        status: response.status,
        operation: input.operation,
        stationId: input.stationId,
        eventId: input.eventId,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[PROCESSOR] Cache refresh request failed", {
      error: message,
      operation: input.operation,
      stationId: input.stationId,
      eventId: input.eventId,
    });
  }
}
