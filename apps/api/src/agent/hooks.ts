import type { AgentTool, ToolContext, ToolResult } from "./tools.js";

// Before/after seams around every tool call (opencode's tool.execute.before /
// after): one place to rewrite input, audit, or veto, whatever the tool.
// Code mode will register here to give nested calls the same treatment.

export interface ToolHooks {
  before?: (tool: AgentTool, input: unknown, ctx: ToolContext) => Promise<void> | void;
  after?: (tool: AgentTool, input: unknown, ctx: ToolContext, result: ToolResult) => Promise<void> | void;
}

const registered: ToolHooks[] = [];

/** Register hooks; returns an unregister function. */
export function registerToolHooks(hooks: ToolHooks): () => void {
  registered.push(hooks);
  return () => {
    const index = registered.indexOf(hooks);
    if (index >= 0) registered.splice(index, 1);
  };
}

export async function runToolHooks(
  tool: AgentTool,
  input: unknown,
  ctx: ToolContext,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  for (const hooks of registered) await hooks.before?.(tool, input, ctx);
  const result = await run();
  for (const hooks of registered) await hooks.after?.(tool, input, ctx, result);
  return result;
}
