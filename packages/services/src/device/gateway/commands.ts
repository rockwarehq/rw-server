import prisma from "@rw/db";

export const VALID_COMMANDS = ["restart", "diagnostic", "spec:pull"] as const;
export type CommandType = (typeof VALID_COMMANDS)[number];

export interface QueueCommandInput {
  gatewayId: string;
  command: CommandType;
  payload?: Record<string, unknown>;
  expiresIn?: number; // seconds
}

// A queued command handed to the transport (NATS) after it is persisted. The
// CommandQueue row stays the audit record; the sink delivers it to the gateway.
export interface QueuedCommand {
  id: string;
  gatewayId: string;
  command: string;
  payload: Record<string, unknown>;
}

export type CommandSink = (command: QueuedCommand) => void;

let commandSink: CommandSink | null = null;

// apps/api wires this to the NATS command publisher. Null (workers, tests) just
// persists the row without publishing.
export function setCommandSink(sink: CommandSink | null): void {
  commandSink = sink;
}

/**
 * Queue a command for a gateway
 */
export async function queue(input: QueueCommandInput) {
  const { gatewayId, command, payload, expiresIn } = input;

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  const created = await prisma.commandQueue.create({
    data: {
      command,
      payload: payload || {},
      expiresAt,
      gatewayId,
    },
  });

  commandSink?.({ id: created.id, gatewayId, command, payload: payload || {} });

  return created;
}

/**
 * List commands for a gateway
 */
export async function list(gatewayId: string, options?: { status?: string; limit?: number }) {
  const where: Record<string, unknown> = { gatewayId };
  if (options?.status) {
    where.status = options.status;
  }

  return prisma.commandQueue.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: options?.limit || 50,
  });
}

/**
 * Get a command by ID
 */
export async function getById(gatewayId: string, commandId: string) {
  return prisma.commandQueue.findFirst({
    where: { id: commandId, gatewayId },
  });
}

/**
 * Acknowledge a command (gateway received it)
 */
export async function ack(gatewayId: string, commandId: string) {
  const command = await prisma.commandQueue.findFirst({
    where: { id: commandId, gatewayId },
  });

  if (!command) {
    return null;
  }

  await prisma.commandQueue.update({
    where: { id: commandId },
    data: {
      status: "ACK",
      ackedAt: new Date(),
    },
  });

  return { success: true };
}

/**
 * Complete a command with result
 */
export async function complete(
  gatewayId: string,
  commandId: string,
  result: { success: boolean; data?: Record<string, unknown>; error?: string },
) {
  const command = await prisma.commandQueue.findFirst({
    where: { id: commandId, gatewayId },
  });

  if (!command) {
    return null;
  }

  const resultData = result.success ? result.data || {} : { error: result.error || "Unknown error" };

  await prisma.commandQueue.update({
    where: { id: commandId },
    data: {
      status: result.success ? "COMPLETED" : "FAILED",
      completedAt: new Date(),
      result: resultData,
    },
  });

  return { success: true };
}

/**
 * Cancel a pending command
 */
export async function cancel(gatewayId: string, commandId: string) {
  const command = await prisma.commandQueue.findFirst({
    where: { id: commandId, gatewayId },
  });

  if (!command) {
    return { error: "not_found" as const };
  }

  if (command.status !== "PENDING") {
    return { error: "not_pending" as const };
  }

  await prisma.commandQueue.delete({ where: { id: commandId } });

  return { success: true };
}
