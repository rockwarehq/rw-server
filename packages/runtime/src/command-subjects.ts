// NATS subject + stream conventions for gateway commands.
//
//   commands.<gatewayId>.gateway              inbound gateway-level command (cloud -> gw) — JetStream (durable)
//   commands.<gatewayId>.<commandId>.ack      command received     (gw -> cloud) — core, best-effort
//   commands.<gatewayId>.<commandId>.result   command completed    (gw -> cloud) — core, best-effort
//
// Commands are the reverse of tags: the cloud produces into RW_COMMANDS and each
// gateway durably consumes its own commands.<gw>.gateway subject, so a command
// issued while the gateway is offline is delivered on reconnect (not dropped, as
// a core publish would be). Ack/result flow back over core NATS — losing one only
// leaves the CommandQueue audit row showing the earlier lifecycle state.
//
// The gateway mirrors these exact strings in rw-gateway/src/subjects.ts.

export const COMMAND_STREAM = "RW_COMMANDS";

// Only inbound gateway-level commands land in the stream. The `.ack`/`.result`
// (4-token) and device `.command`/`.write` (4-token) subjects deliberately do
// NOT match this 3-token filter, so they never pollute the command stream nor
// get redelivered to the gateway as if they were commands.
export const COMMAND_SUBJECT_FILTER = "commands.*.gateway";

export const COMMAND_ACK_SUBJECT_FILTER = "commands.*.*.ack";
export const COMMAND_RESULT_SUBJECT_FILTER = "commands.*.*.result";

// Mirrors graph-subjects.sanitizeSubjectToken and the gateway's sanitizeToken.
function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}

export function deriveGatewayCommandSubject(gatewayId: string): string {
  const token = sanitizeSubjectToken(gatewayId);
  if (!token) throw new Error("gatewayId must produce a non-empty NATS subject token");
  return `commands.${token}.gateway`;
}

export interface CommandEnvelope {
  id: string;
  command: string;
  payload: Record<string, unknown>;
}

// gw -> cloud lifecycle payloads (published core on the .ack/.result subjects).
export interface CommandAck {
  commandId: string;
  gatewayId: string;
  ts?: number;
}

export interface CommandResult {
  commandId: string;
  gatewayId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  ts?: number;
}
