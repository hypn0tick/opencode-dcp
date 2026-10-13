import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAdapter } from "../lib/claude/host";
import type { AnthropicRequest } from "../lib/claude/wire";

/**
 * The host shim drives opencode-dcp's context pipeline over a Claude request
 * without an OpenCode server. These pin the observable effects on a fresh
 * session (system prompt injected, boundary tags added so the model can name
 * ranges), that the body stays a valid request, and that request classes the
 * pipeline must not touch pass through untouched.
 */

function baseRequest(): AnthropicRequest {
  return {
    model: "claude-opus-4-8",
    system: "You are helpful.",
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "an answer" }] },
      { role: "user", content: "second question" },
    ],
    max_tokens: 1024,
  };
}

test("injects the DCP system prompt", async () => {
  const out = await new ClaudeAdapter().apply(baseRequest(), { sessionId: "s1" });
  const system = out.system;
  assert.ok(Array.isArray(system), "system becomes a block array once a part is appended");
  const text = (system as Array<Record<string, unknown>>).map((b) => String(b.text)).join("\n");
  assert.ok(text.includes("You are helpful."), "original system is preserved");
  assert.ok(text.includes("manage your own context window"), "DCP instructions are appended");
});

test("adds boundary tags to user turns", async () => {
  const out = await new ClaudeAdapter().apply(baseRequest(), { sessionId: "s2" });
  const userTexts = out.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  assert.ok(
    userTexts.some((t) => t.includes("dcp-message-id")),
    "at least one user turn is tagged",
  );
});

test("keeps the request otherwise valid and ordered", async () => {
  const out = await new ClaudeAdapter().apply(baseRequest(), { sessionId: "s3" });
  assert.equal(out.model, "claude-opus-4-8");
  assert.equal(out.max_tokens, 1024);
  assert.deepEqual(
    out.messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
});

test("leaves a compaction request untouched", async () => {
  const req = baseRequest();
  const out = await new ClaudeAdapter().apply(req, { sessionId: "s4", requestClass: "compaction" });
  assert.deepEqual(out, req);
});

test("leaves a sub-agent request untouched by default", async () => {
  const req = baseRequest();
  const out = await new ClaudeAdapter().apply(req, { sessionId: "s5", requestClass: "subagent" });
  assert.deepEqual(out, req);
});

test("processes a sub-agent request when allowSubAgents is set", async () => {
  const req = baseRequest();
  const adapter = new ClaudeAdapter({ dcp: { allowSubAgents: true } });
  const out = await adapter.apply(req, { sessionId: "s6", requestClass: "subagent" });
  assert.notDeepEqual(out, req);
});

test("is a no-op when DCP is disabled", async () => {
  const req = baseRequest();
  const out = await new ClaudeAdapter({ dcp: { enabled: false } }).apply(req, { sessionId: "s7" });
  assert.deepEqual(out, req);
});
