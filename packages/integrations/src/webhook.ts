import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ActionContext, ActionDefinition, IntegrationType } from "./types.js";

const configSchema = z.object({
  url: z.url(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  // Where the HMAC lands when a signing secret is configured.
  signatureHeader: z.string().min(1).default("x-rw-signature"),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
});

const secretSchema = z.object({
  signingSecret: z.string().min(1).optional(),
});

export type WebhookConfig = z.infer<typeof configSchema>;
export type WebhookSecret = z.infer<typeof secretSchema>;

const sendInputSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  headers: z.record(z.string(), z.string()).default({}),
});

type SendInput = z.infer<typeof sendInputSchema>;

async function runSend(
  input: SendInput,
  context: ActionContext<WebhookConfig, WebhookSecret>,
): Promise<{ status: number }> {
  const { config, secret } = context;
  const body = JSON.stringify(input.payload);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...input.headers,
  };
  if (secret.signingSecret) {
    headers[config.signatureHeader] = createHmac("sha256", secret.signingSecret).update(body).digest("hex");
  }

  const response = await fetch(config.url, {
    method: config.method,
    headers,
    body,
    signal: context.signal ?? AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Webhook failed with status ${response.status}: ${detail.slice(0, 300)}`);
  }

  return { status: response.status };
}

const send: ActionDefinition<WebhookConfig, WebhookSecret> = {
  key: "send",
  displayName: "Send Webhook",
  description: "POST a JSON payload to the configured URL, optionally HMAC-signed.",
  latest: "1",
  versions: {
    "1": {
      inputSchema: sendInputSchema,
      run: (input, context) => runSend(input as SendInput, context),
    },
  },
};

export const webhookIntegration: IntegrationType<WebhookConfig, WebhookSecret> = {
  type: "webhook",
  displayName: "Webhook",
  description: "Send a signed JSON payload to an external URL.",
  execution: "server",
  configSchema,
  secretSchema,
  actions: [send],
};
