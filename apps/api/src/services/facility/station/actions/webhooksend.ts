import { z } from "zod";
import { stationActionConfig } from "../../../../config.js";
import type { StationActionDefinition } from "./types.js";

interface WebhookSendInput {
  url: string;
  payload?: string;
}

const webhookSendInputSchema = z
  .object({
    url: z.string().min(1),
    payload: z.string().optional(),
  })
  .passthrough();

export const webhookSendAction: StationActionDefinition<WebhookSendInput> = {
  key: "webhook.send",
  displayName: "Send Webhook",
  description: "Send a webhook payload to an external URL",
  inputSchema: webhookSendInputSchema,
  async execute(context, input) {
    let webhookUrl: URL;

    try {
      webhookUrl = new URL(input.url);
    } catch {
      throw new Error("Invalid webhook URL");
    }

    if (webhookUrl.protocol !== "http:" && webhookUrl.protocol !== "https:") {
      throw new Error("Webhook URL must use http or https");
    }

    let body: string;
    let contentType: string;

    if (typeof input.payload === "string") {
      try {
        body = JSON.stringify(JSON.parse(input.payload));
        contentType = "application/json";
      } catch {
        body = input.payload;
        contentType = "text/plain; charset=utf-8";
      }
    } else {
      body = JSON.stringify(context.payload);
      contentType = "application/json";
    }

    const response = await fetch(webhookUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": contentType,
      },
      body,
      signal: AbortSignal.timeout(stationActionConfig.webhookTimeoutMs),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      const responseSnippet = responseBody.slice(0, 300);
      const details = responseSnippet ? `: ${responseSnippet}` : "";

      throw new Error(`Webhook request failed with status ${response.status}${details}`);
    }
  },
};
