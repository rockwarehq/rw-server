import { z } from "zod";
import type { StationActionDefinition } from "./types.js";

interface LogEventInput {
  message: string;
  category?: string;
}

const logEventInputSchema = z
  .object({
    message: z.string().min(1),
    category: z.string().min(1).optional(),
  })
  .passthrough();

export const logEventAction: StationActionDefinition<LogEventInput> = {
  key: "log.event",
  displayName: "Log Event",
  description: "Log event details to server logs",
  inputSchema: logEventInputSchema,
  async execute(context, input) {
    console.log("[STATION_EVENT_ACTION]", {
      action: "log.event",
      executionId: context.executionId,
      eventId: context.eventId,
      stationId: context.stationId,
      workspaceId: context.workspaceId,
      actionId: context.actionId,
      actionIndex: context.actionIndex,
      message: input.message,
      category: input.category,
    });
  },
};
