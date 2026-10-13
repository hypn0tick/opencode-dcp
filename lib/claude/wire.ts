/**
 * Conversion between the Anthropic Messages API request shape and the
 * provider-neutral `WireMessage[]`/`SystemPart[]` that opencode-dcp's context
 * pipeline operates on (`lib/transform.ts`, `lib/transcript/scan.ts`).
 *
 * The Claude Code adapter sits on the wire: it receives a `/v1/messages`
 * request body, runs the DCP pipeline over the converted transcript, and sends
 * the converted-back body onward. So this module is a round trip, not a
 * one-way import, and it is lossless for everything the pipeline does not
 * touch: every original block is retained verbatim and re-emitted unless DCP
 * changed its text.
 *
 * Mapping rules, driven by what the scanner and strategies require:
 *  - A Claude `tool_result` block lives inside a `user` message, but the
 *    scanner only records results from a `role:"tool"` message. So a user
 *    message's `tool_result` blocks are pulled into a separate `role:"tool"`
 *    WireMessage; its remaining blocks stay a `role:"user"` WireMessage.
 *  - `tool_use` → `tool-call` (assistant), `thinking` → `reasoning`.
 *  - Any block the pipeline neither measures by discriminant nor edits
 *    (`image`, `document`, `redacted_thinking`, server-tool blocks, future
 *    kinds) becomes an opaque part carrying the raw block. The pipeline ignores
 *    an unknown `type`; measurement still counts its strings; boundary tags and
 *    pruning never touch it. It round-trips verbatim.
 *  - `role:"system"` messages stay out of the pipeline and the first user
 *    message is pinned (see `toWire`); both go back verbatim in place.
 *
 * Provenance: each emitted WireMessage carries a stable `id` of the form
 * `claude:g<n>` (`:u`/`:t` suffix when one Claude message splits into a user
 * and a tool WireMessage). `fromWire` groups by it to rebuild each original
 * message in its original block order; a WireMessage without such an id is one
 * DCP created (a spliced summary or the appended reminder) and becomes a fresh
 * `user` text message.
 */

import {
  toolResultToText,
  type ContentPart,
  type SystemPart,
  type ToolContent,
  type ToolResultValue,
  type WireMessage,
} from "../types";

/** A Claude content block. Only `type` is interpreted; the rest is retained. */
export type AnthropicBlock = { type: string } & Record<string, unknown>;

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicBlock[];
  [key: string]: unknown;
}

/** The parts of a `/v1/messages` body this module reads. Others pass through. */
export interface AnthropicRequest {
  system?: string | AnthropicBlock[];
  messages: AnthropicMessage[];
  [key: string]: unknown;
}

/**
 * Opaque carrier for a block the pipeline does not model. The `type` is
 * deliberately not a `ContentPart` discriminant, so scan/inject/prune skip it
 * while `measureMessagesChars` still counts the raw block's strings.
 */
interface OpaquePart {
  type: "claude-opaque";
  raw: AnthropicBlock;
}

type AdapterPart = ContentPart | OpaquePart;

/** Per-original-message record for rebuilding the request after DCP edits. */
interface GroupMeta {
  role: "user" | "assistant" | "system";
  /** Original blocks in order. Non-array (string) content is normalized here. */
  blocks: AnthropicBlock[];
  /** Other top-level fields on the Claude message, replayed verbatim. */
  rest: Record<string, unknown>;
  /** Flattened text of each `tool_result` block at convert time, by id. */
  resultText: Map<string, string>;
  /** Content arrived as a bare string: collapse back to one when still one text block. */
  contentWasString: boolean;
  /** Re-emitted verbatim whatever the pipeline did to it. */
  pinned?: boolean;
}

export interface WireMeta {
  groups: GroupMeta[];
  /** Original `system`, so untouched system blocks keep cache_control etc. */
  systemBlocks: AnthropicBlock[];
  /** Whether `system` arrived as a bare string (re-emit as a string if so). */
  systemWasString: boolean;
  /** Count of system parts that came from the request (extras are DCP-added). */
  systemCount: number;
}

export interface ToWireResult {
  system: SystemPart[];
  messages: WireMessage[];
  meta: WireMeta;
}

const GROUP_PREFIX = "claude:g";

function asBlocks(content: string | AnthropicBlock[]): AnthropicBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

function blockText(block: AnthropicBlock): string {
  return typeof block.text === "string" ? block.text : "";
}

/** Claude `tool_result.content` (string | blocks) → a `ToolResultValue`. */
function toolResultValue(block: AnthropicBlock): ToolResultValue {
  const isError = block.is_error === true;
  const content = block.content;
  if (typeof content === "string") {
    return isError ? { type: "error", value: content } : { type: "text", value: content };
  }
  if (Array.isArray(content)) {
    const parts: ToolContent[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && (item as AnthropicBlock).type === "text") {
        parts.push({ type: "text", text: blockText(item as AnthropicBlock) });
      } else if (item && typeof item === "object" && (item as AnthropicBlock).type === "image") {
        parts.push({ type: "file", uri: "", mime: "image", name: undefined });
      }
    }
    if (isError) {
      return { type: "error", value: toolResultToText({ type: "content", value: parts }) };
    }
    return { type: "content", value: parts };
  }
  return isError ? { type: "error", value: "" } : { type: "text", value: "" };
}

function toContentPart(block: AnthropicBlock): AdapterPart {
  switch (block.type) {
    case "text":
      return { type: "text", text: blockText(block) };
    case "tool_use":
      return {
        type: "tool-call",
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input: block.input,
      };
    case "thinking":
      return {
        type: "reasoning",
        text: typeof block.thinking === "string" ? block.thinking : blockText(block),
        encrypted: typeof block.signature === "string" ? block.signature : undefined,
      };
    default:
      return { type: "claude-opaque", raw: block };
  }
}

/** Builds a WireMessage, tagging provenance through `id`. */
function wire(id: string, role: WireMessage["role"], content: AdapterPart[]): WireMessage {
  return { id, role, content: content as ContentPart[] };
}

/**
 * Converts a Claude request to the pipeline's transcript. The first user
 * message carries Claude Code's CLAUDE.md and memory context, so it is pinned:
 * the pipeline still sees it (for context sizing and its system guidance), but
 * `fromWire` sends the original, so pruning or tagging never changes it.
 */
export function toWire(request: AnthropicRequest): ToWireResult {
  const groups: GroupMeta[] = [];
  const messages: WireMessage[] = [];
  const first = request.messages[0];
  const pinFirst =
    first?.role === "user" && !asBlocks(first.content).some((b) => b.type === "tool_result");

  request.messages.forEach((message, index) => {
    const blocks = asBlocks(message.content);
    const { role, content, ...rest } = message;
    const resultText = new Map<string, string>();
    const pinned = index === 0 && pinFirst;
    groups.push({
      role,
      blocks,
      rest,
      resultText,
      contentWasString: typeof content === "string",
      pinned,
    });

    // Hook output and reminders; the last carries Claude Code's message cache
    // breakpoint. They stay out of the pipeline and go back verbatim.
    if (role === "system") return;

    if (role === "assistant") {
      messages.push(wire(`${GROUP_PREFIX}${index}`, role, blocks.map(toContentPart)));
      return;
    }

    // A user message: split tool_result blocks into a role:"tool" message and
    // keep the rest as role:"user", each in original relative order.
    const userParts: AdapterPart[] = [];
    const toolParts: ContentPart[] = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const id = String(block.tool_use_id ?? "");
        const value = toolResultValue(block);
        resultText.set(id, toolResultToText(value));
        toolParts.push({ type: "tool-result", id, name: "", result: value });
      } else {
        userParts.push(toContentPart(block));
      }
    }
    if (userParts.length > 0) messages.push(wire(`${GROUP_PREFIX}${index}:u`, "user", userParts));
    if (toolParts.length > 0) messages.push(wire(`${GROUP_PREFIX}${index}:t`, "tool", toolParts));
  });

  const systemWasString = typeof request.system === "string";
  const systemBlocks = request.system === undefined ? [] : asBlocks(request.system);
  const system: SystemPart[] = systemBlocks.map((block) => ({
    type: "text",
    text: blockText(block),
  }));

  return {
    system,
    messages,
    meta: { groups, systemBlocks, systemWasString, systemCount: system.length },
  };
}

function groupIndexOf(id: string | undefined): number | undefined {
  if (typeof id !== "string" || !id.startsWith(GROUP_PREFIX)) return undefined;
  const digits = id.slice(GROUP_PREFIX.length).split(":", 1)[0] ?? "";
  if (!/^\d+$/.test(digits)) return undefined;
  return Number(digits);
}

function textOfParts(parts: ContentPart[]): string[] {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text);
}

/** A fresh user text message DCP produced (spliced summary or reminder). */
function syntheticMessage(parts: ContentPart[]): AnthropicMessage {
  const text = textOfParts(parts).join("\n");
  return { role: "user", content: [{ type: "text", text }] };
}

/**
 * Rebuilds `{ system, messages }` from the pipeline's edited transcript. Each
 * surviving provenance group is reassembled in its original block order; a
 * block whose text DCP changed is re-emitted with the new text, every other
 * block verbatim. Messages DCP removed are simply absent; messages DCP added
 * become plain user text messages.
 */
export function fromWire(
  messages: WireMessage[],
  meta: WireMeta,
): { messages: AnthropicMessage[] } {
  // Collect the surviving WireMessages per group (a user group has up to two).
  const userParts = new Map<number, ContentPart[]>();
  const toolParts = new Map<number, Extract<ContentPart, { type: "tool-result" }>[]>();
  const order: Array<
    { kind: "group"; index: number } | { kind: "synthetic"; parts: ContentPart[] }
  > = [];
  const seenGroup = new Set<number>();

  for (const message of messages) {
    const index = groupIndexOf(message.id);
    if (index === undefined || meta.groups[index] === undefined) {
      order.push({ kind: "synthetic", parts: message.content });
      continue;
    }
    if (meta.groups[index]!.pinned) continue;
    if (!seenGroup.has(index)) {
      seenGroup.add(index);
      order.push({ kind: "group", index });
    }
    if (message.role === "tool") {
      const results = message.content.filter(
        (p): p is Extract<ContentPart, { type: "tool-result" }> => p.type === "tool-result",
      );
      toolParts.set(index, (toolParts.get(index) ?? []).concat(results));
    } else {
      userParts.set(index, (userParts.get(index) ?? []).concat(message.content));
    }
  }

  // Pinned and system groups go back verbatim in their original place; a
  // message DCP added takes the place of the first group it replaced.
  const verbatim = (group: GroupMeta) => group.pinned === true || group.role === "system";
  const pinned = meta.groups.flatMap((group, i) => (verbatim(group) ? [i] : []));
  const removed = meta.groups.flatMap((group, i) => (verbatim(group) || seenGroup.has(i) ? [] : [i]));
  const out: AnthropicMessage[] = [];
  let nextPinned = 0;
  const flushPinned = (before: number) => {
    while (nextPinned < pinned.length && pinned[nextPinned]! < before) {
      const group = meta.groups[pinned[nextPinned++]!]!;
      out.push({
        role: group.role,
        content: collapseContent(group.blocks, group.contentWasString),
        ...group.rest,
      });
    }
  };
  let last = -1;
  if (meta.groups[0]?.pinned) {
    flushPinned(1);
    last = 0;
  }
  for (const entry of order) {
    if (entry.kind === "synthetic") {
      const at = removed.find((i) => i > last);
      if (at !== undefined) flushPinned(at);
      out.push(syntheticMessage(entry.parts));
      continue;
    }
    flushPinned(entry.index);
    last = entry.index;
    const group = meta.groups[entry.index]!;
    out.push(
      rebuildMessage(group, userParts.get(entry.index) ?? [], toolParts.get(entry.index) ?? []),
    );
  }
  flushPinned(Infinity);

  return { messages: out };
}

/**
 * Reassembles a message by walking its original blocks, overlaying only the
 * text the pipeline changed. One cursor runs over the message's main parts
 * (assistant content, or a user message's non-result parts) and, for a user
 * message, a second over its `role:"tool"` results.
 */
function rebuildMessage(
  group: GroupMeta,
  mainParts: ContentPart[],
  toolResults: Extract<ContentPart, { type: "tool-result" }>[],
): AnthropicMessage {
  const blocks: AnthropicBlock[] = [];
  let m = 0;
  let t = 0;
  for (const block of group.blocks) {
    if (block.type === "tool_result") {
      const part = toolResults[t++];
      if (part === undefined) continue; // result was pruned away with its message
      const id = String(block.tool_use_id ?? "");
      const current = toolResultToText(part.result);
      if (current === group.resultText.get(id)) blocks.push(block); // untouched: verbatim
      else blocks.push({ ...block, content: current, is_error: part.result.type === "error" });
      continue;
    }
    const part = mainParts[m++] as AdapterPart | undefined;
    if (part === undefined) continue;
    if (part.type === "text") {
      blocks.push(
        part.text === blockText(block) ? block : { ...block, type: "text", text: part.text },
      );
    } else if (part.type === "claude-opaque") {
      blocks.push(part.raw);
    } else {
      blocks.push(block); // tool-call, reasoning: not edited by the pipeline
    }
  }
  return {
    role: group.role,
    content: collapseContent(blocks, group.contentWasString),
    ...group.rest,
  };
}

/** Re-collapses to a bare string when the content arrived as one and stays single text. */
function collapseContent(blocks: AnthropicBlock[], wasString: boolean): string | AnthropicBlock[] {
  if (wasString && blocks.length === 1 && blocks[0]!.type === "text") return blockText(blocks[0]!);
  return blocks;
}

/**
 * Rebuilds the request `system` from the pipeline's (possibly appended) system
 * parts. The original blocks are re-emitted verbatim so their `cache_control`
 * and other fields survive; parts beyond the original count are DCP's appended
 * instruction and become new text blocks.
 */
export function rebuildSystem(
  parts: SystemPart[],
  meta: WireMeta,
): string | AnthropicBlock[] | undefined {
  if (meta.systemBlocks.length === 0 && parts.length <= meta.systemCount) return undefined;
  const blocks = meta.systemBlocks.slice();
  for (let i = meta.systemCount; i < parts.length; i++) {
    blocks.push({ type: "text", text: parts[i]!.text });
  }
  if (meta.systemWasString && blocks.length === 1 && blocks[0]!.type === "text") {
    return blockText(blocks[0]!);
  }
  return blocks;
}
