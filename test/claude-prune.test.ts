import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAdapter } from "../lib/claude/host";
import { findPruneCalls, offeredPruneName, rewritePruneResult } from "../lib/claude/prune-router";
import type { AnthropicRequest } from "../lib/claude/wire";
import type { WireMessage } from "../lib/types";

/**
 * The adapter offers a `prune` tool and routes the model's call into
 * opencode-dcp's prune execution on the following request, where the call and
 * its result arrive. These exercise the pure helpers and the full loop:
 * dispatch -> model prunes over the ids it saw -> next dispatch executes it,
 * rewrites the error result to an ack, and compresses the covered range.
 */

test("findPruneCalls matches bare and namespaced prune tool names", () => {
  const messages: WireMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "a", name: "prune", input: { x: 1 } }],
    },
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "b", name: "mcp__dcp__prune", input: { y: 2 } }],
    },
    { role: "assistant", content: [{ type: "tool-call", id: "c", name: "Bash", input: {} }] },
  ];
  assert.deepEqual(findPruneCalls(messages).map((c) => c.id), ["a", "b"]);
});

test("offeredPruneName finds DCP's prune tools and no other server's", () => {
  assert.equal(offeredPruneName([{ name: "Bash" }, { name: "mcp__dcp__prune" }]), "mcp__dcp__prune");
  assert.equal(offeredPruneName([{ name: "Bash" }, { name: "mcp__x__prune" }]), undefined);
  assert.equal(offeredPruneName(undefined), undefined);
  const calls = findPruneCalls([
    { role: "assistant", content: [{ type: "tool-call", id: "x", name: "mcp__x__prune", input: {} }] },
  ]);
  assert.deepEqual(calls, []);
});

test("rewritePruneResult replaces the matching tool result value", () => {
  const messages: WireMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "a",
          name: "",
          result: { type: "error", value: "No such tool" },
        },
      ],
    },
  ];
  rewritePruneResult(messages, "a", "Pruned 3 ranges.");
  const result = messages[0]!.content[0];
  assert.ok(
    result &&
      result.type === "tool-result" &&
      result.result.type === "text" &&
      result.result.value === "Pruned 3 ranges.",
  );
});

test("the adapter offers a prune tool when none is present", async () => {
  const out = await new ClaudeAdapter().apply(
    { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] },
    { sessionId: "offer" },
  );
  assert.ok(offeredPruneName(out.tools) !== undefined, "prune is offered on the wire");
});

test("the adapter does not double-offer when a mod already offers prune", async () => {
  const req: AnthropicRequest = {
    model: "claude-opus-4-8",
    tools: [{ name: "mcp__dcp__prune", description: "d", input_schema: {} }],
    messages: [{ role: "user", content: "hi" }],
  };
  const out = await new ClaudeAdapter().apply(req, { sessionId: "mod" });
  const pruneTools = (out.tools as Array<{ name: string }>).filter((t) => t.name.endsWith("prune"));
  assert.equal(pruneTools.length, 1);
});

function idsFrom(request: AnthropicRequest): string[] {
  const ids = new Set<string>();
  for (const m of request.messages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    for (const match of text.matchAll(/dcp-message-id>\s*(m\d+)/g)) ids.add(match[1]!);
  }
  return [...ids];
}

test("a prune call on the next request compresses the covered range", async () => {
  const adapter = new ClaudeAdapter();
  const base = [
    { role: "user" as const, content: "session context" },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "ready" }] },
    { role: "user" as const, content: "start task alpha" },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "working on alpha" }] },
    { role: "user" as const, content: "now task beta" },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "working on beta" }] },
    { role: "user" as const, content: "current task gamma" },
  ];

  // Dispatch 1: the model sees boundary ids on the user turns.
  const first = await adapter.apply(
    { model: "claude-opus-4-8", messages: base },
    { sessionId: "loop" },
  );
  const ids = idsFrom(first);
  assert.ok(ids.length >= 2, `expected at least two boundary ids, got ${ids.join(",")}`);
  const [startId, endId] = [ids[0]!, ids[1]!];

  // Dispatch 2: the stored transcript plus the model's prune call and the
  // engine's no-such-tool error result.
  const next: AnthropicRequest = {
    model: "claude-opus-4-8",
    messages: [
      ...base,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_p1",
            name: "prune",
            input: {
              topic: "alpha/beta done",
              content: [
                { startId, endId, summary: "User ran tasks alpha and beta; both handled." },
              ],
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_p1",
            content: "<tool_use_error>Error: No such tool available: prune</tool_use_error>",
            is_error: true,
          },
        ],
      },
    ],
  };
  const out = await adapter.apply(next, { sessionId: "loop" });
  const dump = JSON.stringify(out.messages);

  assert.ok(dump.includes("[Compressed conversation section]"), "a summary was spliced in");
  assert.ok(!dump.includes("start task alpha"), "the covered alpha turn was removed");
  assert.ok(dump.includes("current task gamma"), "the uncovered gamma turn remains");
  assert.ok(
    !dump.includes("No such tool available"),
    "the prune error result was rewritten to an ack",
  );

  // Idempotent: a repeat of the same request does not re-execute or throw, and
  // stays compressed.
  const again = await adapter.apply(next, { sessionId: "loop" });
  assert.ok(
    !JSON.stringify(again.messages).includes("start task alpha"),
    "still compressed on repeat",
  );
});
