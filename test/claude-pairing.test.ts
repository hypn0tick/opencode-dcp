import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAdapter } from "../lib/claude/host";
import type { AnthropicRequest } from "../lib/claude/wire";

/**
 * The Anthropic API rejects a request where an assistant `tool_use` has no
 * following `tool_result`, or a `tool_result` references no `tool_use`. Model-
 * driven compression picks ranges by boundary id and can cover one half of a
 * pair, so the adapter must keep every emitted request paired. This drives a
 * prune whose range covers a tool result but not the assistant call that
 * produced it, and asserts the output has no orphan.
 */

interface Block {
  type: string;
  id?: string;
  tool_use_id?: string;
  [k: string]: unknown;
}

function pairings(messages: AnthropicRequest["messages"]): {
  uses: Set<string>;
  results: Set<string>;
} {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content as Block[]) {
      if (block.type === "tool_use" && typeof block.id === "string") uses.add(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.add(block.tool_use_id);
      }
    }
  }
  return { uses, results };
}

/** The id tag appended right after a known text marker, e.g. after "file list". */
function idAfter(request: AnthropicRequest, marker: string): string | undefined {
  const text = JSON.stringify(request.messages);
  const re = new RegExp(`${marker}[^"]*?dcp-message-id>\\s*(m\\d+)`);
  return re.exec(text)?.[1];
}

test("compression that covers a tool result but not its call leaves no orphan", async () => {
  const adapter = new ClaudeAdapter();
  const base: AnthropicRequest["messages"] = [
    { role: "user", content: "do a thing" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file list" }] },
    { role: "assistant", content: [{ type: "text", text: "done, next?" }] },
    { role: "user", content: "yes continue" },
  ];

  const first = await adapter.apply(
    { model: "claude-opus-4-8", messages: base },
    { sessionId: "pair" },
  );
  const startId = idAfter(first, "file list");
  const endId = idAfter(first, "yes continue");
  assert.ok(
    startId && endId,
    `need ids on the tool result and the last user turn (got ${startId}, ${endId})`,
  );

  const next: AnthropicRequest = {
    model: "claude-opus-4-8",
    messages: [
      ...base,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_p",
            name: "prune",
            input: {
              topic: "drop mid",
              content: [{ startId, endId, summary: "Ran ls; continued." }],
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_p",
            content: "<tool_use_error>Error: No such tool available: prune</tool_use_error>",
            is_error: true,
          },
        ],
      },
    ],
  };

  const out = await adapter.apply(next, { sessionId: "pair" });
  const { uses, results } = pairings(out.messages);
  const orphanUses = [...uses].filter((id) => !results.has(id));
  const orphanResults = [...results].filter((id) => !uses.has(id));
  assert.deepEqual(
    orphanUses,
    [],
    `assistant tool_use ids with no result: ${orphanUses.join(",")}`,
  );
  assert.deepEqual(orphanResults, [], `tool_result ids with no call: ${orphanResults.join(",")}`);
});
