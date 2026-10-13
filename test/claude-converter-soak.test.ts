import assert from "node:assert/strict";
import { test } from "node:test";

import { fromWire, toWire, type AnthropicRequest } from "../lib/claude/wire";
import { makeToolResultReplacement } from "../lib/types";

/**
 * Composite-turn soak for the wire converter: the shapes a real extended-thinking
 * agentic session produces, which the per-feature wire tests only exercise one
 * block at a time. The fragile code is `rebuildMessage`'s dual cursor (one over
 * an assistant turn's main parts, one over a user turn's tool results): a turn
 * mixing thinking, text and several parallel `tool_use` blocks, or a user turn
 * that is nothing but `tool_result`s, misaligns the cursor if the mapping drifts.
 * These pin that (1) such a transcript round-trips byte-identical when the
 * pipeline touches nothing, so every thinking `signature` survives (the API
 * requires them on replay), and (2) pruning one of several parallel
 * results rewrites exactly that result and leaves its siblings and every
 * reasoning/tool-call block verbatim.
 */

/** Two turns of parallel tool use with interleaved thinking. */
function compositeTranscript(): AnthropicRequest {
  return {
    model: "claude-opus-4-8",
    system: "You are helpful.",
    messages: [
      { role: "user", content: "analyze config.ts and server.ts" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "read both in parallel", signature: "sigA" },
          { type: "text", text: "Reading both files." },
          { type: "tool_use", id: "r1", name: "Read", input: { path: "config.ts" } },
          { type: "tool_use", id: "r2", name: "Read", input: { path: "server.ts" } },
        ],
      },
      // A user turn with only tool_results: no user WireMessage is emitted.
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "r1", content: "config body" },
          { type: "tool_result", tool_use_id: "r2", content: "server body" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "now answer", signature: "sigB" },
          { type: "text", text: "Both look fine." },
        ],
      },
      { role: "user", content: "thanks" },
    ],
  };
}

test("composite multi-turn transcript round-trips byte-identical when untouched", () => {
  const req = compositeTranscript();
  const { messages, meta } = toWire(req);
  const back = fromWire(messages, meta);
  // Signatures, block order, parallel tool_use ids, and the tool-only user turn
  // all survive.
  assert.deepEqual(back.messages, req.messages);
});

test("pruning one parallel result rewrites only it and keeps siblings and thinking verbatim", () => {
  const req = compositeTranscript();
  const { messages, meta } = toWire(req);

  // Prune r1's output in place, as pruneToolOutputs would; leave r2 alone.
  const tool = messages.find((m) => m.role === "tool")!;
  tool.content = tool.content.map((p) =>
    p.type === "tool-result" && p.id === "r1"
      ? { ...p, result: makeToolResultReplacement("[Output removed]") }
      : p,
  );

  const back = fromWire(messages, meta);
  const blocks = (m: (typeof back.messages)[number]) => m.content as Array<Record<string, unknown>>;

  // The tool-result turn: r1 rewritten, r2 untouched (cursor stayed aligned).
  const results = back.messages[2]!;
  assert.equal(blocks(results)[0]!.content, "[Output removed]");
  assert.equal(blocks(results)[0]!.is_error, false);
  assert.equal(blocks(results)[1]!.content, "server body");

  // The assistant turn that issued the calls is wholly verbatim: both thinking
  // signatures and both parallel tool_use blocks, in order.
  assert.deepEqual(back.messages[1], req.messages[1]);
  assert.deepEqual(back.messages[3], req.messages[3]);
});
