import { z } from "zod";
import type { StationActionDefinition } from "./types.js";

interface AlertCreateInput {
  message: string;
  severity?: "info" | "warning" | "critical";
}

const alertCreateInputSchema = z
  .object({
    message: z.string().min(1),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  })
  .passthrough();

export const alertCreateAction: StationActionDefinition<AlertCreateInput> = {
  key: "alert.create",
  displayName: "Create Alert",
  description: "Create an alert notification",
  inputSchema: alertCreateInputSchema,
  async execute(context, input) {
    console.log("[STATION_EVENT_ACTION]", {
      action: "alert.create",
      executionId: context.executionId,
      eventId: context.eventId,
      stationId: context.stationId,
      workspaceId: context.workspaceId,
      actionId: context.actionId,
      actionIndex: context.actionIndex,
      message: input.message,
      severity: input.severity || "warning",
    });
  },
};
