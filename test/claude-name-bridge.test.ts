import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAdapter } from "../lib/claude/host";
import { offeredPruneName, rewriteOfferedPruneDef } from "../lib/claude/prune-router";
import { createSseTap, renameToolUseLine, transformBody } from "../lib/claude/proxy";
import type { AnthropicRequest } from "../lib/claude/wire";

/**
 * The bidirectional name-bridge lets a no-op Claude Code mod answer the prune
 * call cleanly without touching opencode-dcp's prompts. The request side offers
 * the plugin's own bare `prune` (the model follows unmodified guidance); the
 * response side renames the model's `prune` tool_use to the mod's namespaced
 * `mcp__dcp__prune` so the engine routes a clean success to the mod. These pin
 * both halves, and that the rename changes only the tool_use name, not usage,
 * text, or any other event.
 */

const TU_PRUNE =
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"prune","input":{}}}';
const TU_READ =
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"Read","input":{}}}';
const TEXT_START = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}';
const USAGE = 'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}';
const EVENT = "event: content_block_start";

test("renameToolUseLine renames only a matching tool_use start", () => {
  const out = renameToolUseLine(TU_PRUNE, "prune", "mcp__dcp__prune");
  const block = (
    JSON.parse(out.slice("data: ".length)) as { content_block: { name: string } }
  ).content_block;
  assert.equal(block.name, "mcp__dcp__prune");
});

test("renameToolUseLine leaves every other line byte-for-byte", () => {
  for (const line of [TU_READ, TEXT_START, USAGE, EVENT, "data: not json", ""]) {
    assert.equal(renameToolUseLine(line, "prune", "mcp__dcp__prune"), line, line);
  }
});

test("the SSE tap renames across a chunk boundary and preserves usage", () => {
  const stream = `${TU_PRUNE}\n${USAGE}\n`;
  const expected = `${renameToolUseLine(TU_PRUNE, "prune", "mcp__dcp__prune")}\n${USAGE}\n`;
  for (const mid of [5, 30, 70]) {
    const r = createSseTap({ rename: { from: "prune", to: "mcp__dcp__prune" } });
    const out = r.transform(stream.slice(0, mid)) + r.transform(stream.slice(mid)) + r.flush();
    assert.equal(out, expected, `split at ${mid}`);
    assert.ok(out.includes(USAGE), "usage line is verbatim");
  }
});

test("the SSE tap renames a final line with no trailing newline on flush", () => {
  const r = createSseTap({ rename: { from: "prune", to: "mcp__dcp__prune" } });
  const out = r.transform(`${USAGE}\n`) + r.transform(TU_PRUNE) + r.flush();
  assert.equal(out, `${USAGE}\n${renameToolUseLine(TU_PRUNE, "prune", "mcp__dcp__prune")}`);
});

test("offeredPruneName finds a namespaced mod prune, and nothing otherwise", () => {
  assert.equal(
    offeredPruneName([{ name: "Read" }, { name: "mcp__dcp__prune" }]),
    "mcp__dcp__prune",
  );
  assert.equal(offeredPruneName([{ name: "Read" }]), undefined);
  assert.equal(offeredPruneName(undefined), undefined);
});

test("rewriteOfferedPruneDef renames the mod tool to the canonical bare prune, keeping others", () => {
  const tools = [
    { name: "Read", description: "read", input_schema: { type: "object" } },
    { name: "mcp__dcp__prune", description: "stub", input_schema: { type: "object" } },
  ];
  const out = rewriteOfferedPruneDef(tools, "CANON DESC", {
    type: "object",
    properties: { topic: {} },
  }) as Array<Record<string, unknown>>;
  assert.deepEqual(out[0], tools[0], "other tools untouched");
  assert.equal(out[1]!.name, "prune", "renamed to bare prune");
  assert.equal(out[1]!.description, "CANON DESC");
  assert.deepEqual(out[1]!.input_schema, { type: "object", properties: { topic: {} } });
});

test("apply with a mod present offers bare prune and sets the response rename", async () => {
  const adapter = new ClaudeAdapter();
  const request: AnthropicRequest = {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "Read", description: "read", input_schema: { type: "object" } },
      { name: "mcp__dcp__prune", description: "stub", input_schema: { type: "object" } },
    ],
  };
  const out = await adapter.apply(request, { sessionId: "mod-on" });
  const tools = out.tools as Array<Record<string, unknown>>;
  const prune = tools.find((t) => t.name === "prune");
  assert.ok(prune, "a bare `prune` tool is offered");
  assert.ok(
    String(prune!.description).includes("Replace one or more conversation ranges"),
    "canonical description",
  );
  assert.ok(
    !tools.some((t) => t.name === "mcp__dcp__prune"),
    "the mod's namespaced name is gone from the wire",
  );
  assert.ok(tools.some((t) => t.name === "Read"), "unrelated tools survive");
  const { rename } = await transformBody(JSON.stringify(request), { sessionId: "mod-on-2" }, adapter);
  assert.deepEqual(rename, { from: "prune", to: "mcp__dcp__prune" });
});

test("apply without a mod injects bare prune and renames no response", async () => {
  const adapter = new ClaudeAdapter();
  const out = await adapter.apply(
    { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] },
    { sessionId: "mod-off" },
  );
  const tools = out.tools as Array<Record<string, unknown>>;
  assert.ok(tools.some((t) => t.name === "prune"), "bare prune injected");
  const { rename } = await transformBody(
    JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }),
    { sessionId: "mod-off-2" },
    adapter,
  );
  assert.equal(rename, undefined, "no mod, no response rename");
});
