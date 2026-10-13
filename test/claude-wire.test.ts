import assert from "node:assert/strict";
import { test } from "node:test";

import { fromWire, rebuildSystem, toWire, type AnthropicRequest } from "../lib/claude/wire";
import { makeToolResultReplacement, type WireMessage } from "../lib/types";

/**
 * The adapter is a wire round trip: `/v1/messages` in, DCP pipeline over the
 * converted transcript, converted-back body out. These pin (1) that conversion
 * is lossless for an untouched request, (2) that the scanner's shape
 * requirements are met (tool results become role:"tool", calls role:"assistant"),
 * and (3) that the edits the pipeline actually performs survive the round trip:
 * a replaced tool output, a boundary-tagged user turn, a spliced summary, and a
 * removed message.
 */

function roundTrip(req: AnthropicRequest): AnthropicRequest {
  const { messages, meta } = toWire(req);
  const back = fromWire(messages, meta);
  return { ...req, ...back };
}

test("lossless round trip for a plain text conversation", () => {
  const req: AnthropicRequest = {
    model: "claude-opus-4-8",
    system: "You are helpful.",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
    max_tokens: 100,
  };
  assert.deepEqual(roundTrip(req), req);
});

test("system as an array keeps cache_control when unchanged", () => {
  const req: AnthropicRequest = {
    system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  const { system, meta } = toWire(req);
  assert.deepEqual(rebuildSystem(system, meta), req.system);
});

test("a DCP-appended system part is emitted as a new text block", () => {
  const req: AnthropicRequest = {
    system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  const { system, meta } = toWire(req);
  const appended = [...system, { type: "text" as const, text: "DCP instructions" }];
  assert.deepEqual(rebuildSystem(appended, meta), [
    { type: "text", text: "rules", cache_control: { type: "ephemeral" } },
    { type: "text", text: "DCP instructions" },
  ]);
});

test("tool_use becomes a tool-call on an assistant message", () => {
  const { messages } = toWire({
    messages: [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "sure" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    ],
  });
  const assistant = messages.find((m) => m.role === "assistant")!;
  const call = assistant.content.find((p) => p.type === "tool-call");
  assert.ok(call && call.type === "tool-call" && call.id === "t1" && call.name === "Bash");
});

test("tool_result in a user message becomes a role:tool message", () => {
  const { messages } = toWire({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "output here" },
          { type: "text", text: "thanks, now do X" },
        ],
      },
    ],
  });
  const tool = messages.find((m) => m.role === "tool");
  const user = messages.find((m) => m.role === "user");
  assert.ok(tool, "a role:tool message is emitted");
  const result = tool!.content[0];
  assert.ok(result && result.type === "tool-result" && result.id === "t1");
  assert.ok(user, "trailing user text stays a user message");
});

test("a mixed tool_result + text user message round-trips in original order", () => {
  const req: AnthropicRequest = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { c: 1 } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "out" },
          { type: "text", text: "next" },
        ],
      },
    ],
  };
  assert.deepEqual(roundTrip(req), req);
});

test("a replaced tool output is written back into the tool_result block", () => {
  const req: AnthropicRequest = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "huge file body" }],
      },
    ],
  };
  const { messages, meta } = toWire(req);
  // Simulate pruneToolOutputs replacing the result value in place.
  const tool = messages.find((m) => m.role === "tool")!;
  tool.content = tool.content.map((p) =>
    p.type === "tool-result" ? { ...p, result: makeToolResultReplacement("[Output removed]") } : p,
  );
  const back = fromWire(messages, meta);
  const userMsg = back.messages.find((m) => m.role === "user")!;
  const block = (userMsg.content as Array<{ type: string; content?: unknown }>)[0]!;
  assert.equal(block.content, "[Output removed]");
});

test("a boundary tag appended to user text survives", () => {
  const req: AnthropicRequest = {
    messages: [
      { role: "user", content: "context" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "do the thing" },
    ],
  };
  const { messages, meta } = toWire(req);
  const user = messages[2]!;
  user.content = [{ type: "text", text: "do the thing\n<dcp-message-id>m0001</dcp-message-id>" }];
  const back = fromWire(messages, meta);
  // Content arrived as a string, so the tagged text re-collapses to a string.
  assert.equal(back.messages[2]!.content, "do the thing\n<dcp-message-id>m0001</dcp-message-id>");
});

test("a spliced summary message becomes a user text message", () => {
  const req: AnthropicRequest = {
    messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "new" },
    ],
  };
  const { messages, meta } = toWire(req);
  const summary: WireMessage = {
    role: "user",
    content: [{ type: "text", text: "[Compressed conversation section]" }],
  };
  const spliced = [messages[0]!, summary, ...messages.slice(1)];
  const back = fromWire(spliced, meta);
  assert.equal(back.messages.length, 4);
  assert.deepEqual(back.messages[1], {
    role: "user",
    content: [{ type: "text", text: "[Compressed conversation section]" }],
  });
});

test("the first user message goes out verbatim whatever the pipeline did to it", () => {
  const req: AnthropicRequest = {
    messages: [
      { role: "user", content: "context" },
      { role: "system", content: "SessionStart hook additional context: x" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
  };
  const { messages, meta } = toWire(req);
  messages[0]!.content = [{ type: "text", text: "context, edited" }];
  assert.deepEqual(fromWire(messages, meta).messages, req.messages);
  const summary: WireMessage = {
    id: "spliced",
    role: "user",
    content: [{ type: "text", text: "[Compressed]" }],
  };
  const back = fromWire([messages[0]!, summary], meta).messages;
  assert.deepEqual(back, [
    req.messages[0],
    req.messages[1],
    { role: "user", content: [{ type: "text", text: "[Compressed]" }] },
  ]);
  assert.deepEqual(fromWire([summary, messages[1]!], meta).messages[0], req.messages[0]);
});

test("a removed message drops from the output", () => {
  const req: AnthropicRequest = {
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "second" },
    ],
  };
  const { messages, meta } = toWire(req);
  const kept = messages.filter((m) => m.id !== "claude:g2:u");
  const back = fromWire(kept, meta);
  assert.equal(back.messages.length, 2);
  assert.ok(
    !back.messages.some(
      (m) =>
        m.content === "second" ||
        (Array.isArray(m.content) &&
          m.content.some((b) => (b as { text?: string }).text === "second")),
    ),
  );
});

test("an unknown block kind round-trips verbatim", () => {
  const req: AnthropicRequest = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "what is this" },
        ],
      },
    ],
  };
  assert.deepEqual(roundTrip(req), req);
});

test("a thinking block maps to reasoning and round-trips", () => {
  const req: AnthropicRequest = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think", signature: "sig123" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  assert.deepEqual(roundTrip(req), req);
});
