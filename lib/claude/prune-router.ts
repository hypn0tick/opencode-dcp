/**
 * Routes the model's `prune` tool call to opencode-dcp's prune execution.
 *
 * Claude Code has no `prune` tool of its own, so the adapter offers one by
 * injecting its definition into the outbound request. The model calls it; the
 * call is answered either by a "no such tool" error (proxy alone) or by the
 * no-op mod. Either way the call and its result reach the adapter in the next
 * request, which runs opencode-dcp's `execute` to build the compression block
 * and rewrites the call's result to the ack. The context hook applies the new block on
 * the same pass.
 *
 * A prune call is recognized by tool name, covering both the wire-injected
 * `prune` and the mod's `mcp__dcp__prune`. Execution is keyed by
 * tool-use id so a call that stays in history is executed once, while its
 * result is rewritten on every request that still carries the engine's error.
 */

import { PRUNE_TOOL_NAME } from "../prune-tool";
import { makeToolResultReplacement, type WireMessage } from "../types";

export interface PruneCall {
  /** The tool-use id: finds the matching result, and keys one-time execution. */
  id: string;
  input: unknown;
  /** Position of the issuing assistant message: the transcript before it is what the model saw. */
  index: number;
}

/** A tool whose definition the adapter offers the model on the wire. */
export interface WireToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

/**
 * The tool the plugin's mod registers (plugin `dcp`). Another server's
 * `*__prune` tool is unrelated and passes through untouched.
 */
export const MOD_TOOL_NAME = `mcp__dcp__${PRUNE_TOOL_NAME}`;

function isPruneName(name: string): boolean {
  return name === PRUNE_TOOL_NAME || name === MOD_TOOL_NAME;
}

/**
 * The response-side rename for a request whose tools offered the mod's tool:
 * the model calls the bare `prune` it was shown, renamed back so the mod
 * answers it. Undefined for any other request.
 */
export function responseRename(tools: unknown): { from: string; to: string } | undefined {
  return offeredPruneName(tools) === MOD_TOOL_NAME
    ? { from: PRUNE_TOOL_NAME, to: MOD_TOOL_NAME }
    : undefined;
}

/** The prune calls in a transcript, in order, from assistant tool-call parts. */
export function findPruneCalls(messages: WireMessage[]): PruneCall[] {
  const calls: PruneCall[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    for (const part of message.content) {
      if (part.type === "tool-call" && isPruneName(part.name)) {
        calls.push({ id: part.id, input: part.input, index });
      }
    }
  });
  return calls;
}

/** Replaces a tool-result's value, so the model reads the ack, not the error. */
export function rewritePruneResult(messages: WireMessage[], id: string, text: string): void {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type === "tool-result" && part.id === id) {
        changed = true;
        return { ...part, result: makeToolResultReplacement(text) };
      }
      return part;
    });
    if (changed) message.content = content;
  }
}

/** The wire tool definition for the model-driven `prune` tool. */
export function pruneWireDef(description: string, inputSchema: unknown): WireToolDef {
  return { name: PRUNE_TOOL_NAME, description, input_schema: inputSchema };
}

/** The name of an offered prune tool (`prune` or a mod's `*__prune`), if any. */
export function offeredPruneName(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    if (tool !== null && typeof tool === "object") {
      const name = (tool as { name?: unknown }).name;
      if (typeof name === "string" && isPruneName(name)) return name;
    }
  }
  return undefined;
}

/**
 * Rewrites an already-offered prune tool (the mod's `mcp__dcp__prune`) to
 * opencode-dcp's canonical bare `prune` definition, so the model sees the
 * plugin's own tool and follows its unmodified guidance. Other tools pass
 * through unchanged. The mod's name is restored on the response stream, which
 * is what routes the model's call back to the mod.
 */
export function rewriteOfferedPruneDef(
  tools: unknown,
  description: string,
  inputSchema: unknown,
): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) =>
    tool !== null &&
    typeof tool === "object" &&
    typeof (tool as { name?: unknown }).name === "string" &&
    isPruneName((tool as { name: string }).name)
      ? {
          ...(tool as Record<string, unknown>),
          name: PRUNE_TOOL_NAME,
          description,
          input_schema: inputSchema,
        }
      : tool,
  );
}
