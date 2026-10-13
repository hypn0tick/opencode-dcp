import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAdapter } from "../lib/claude/host";
import type { Usage } from "../lib/claude/host";
import {
  contextFromHeaders,
  createSseTap,
  readUsageLine,
  shouldHandle,
  transformBody,
} from "../lib/claude/proxy";

/** Pins the pure proxy surface: header derivation, path matching, body transform. */

test("contextFromHeaders reads session, class, and the 1M window", () => {
  const h = new Headers({
    "x-claude-code-session-id": "sid",
    "x-claude-code-request-class": "main",
    "anthropic-beta": "fine-grained-2025,context-1m-2025-08-07",
  });
  assert.deepEqual(contextFromHeaders(h), {
    sessionId: "sid",
    requestClass: "main",
    window: 1_000_000,
  });
});

test("contextFromHeaders does not match a stray context-1m substring", () => {
  assert.equal(
    contextFromHeaders(new Headers({ "anthropic-beta": "no-context-1million" })).window,
    undefined,
  );
});

test("shouldHandle matches messages and count_tokens, with or without query", () => {
  assert.equal(shouldHandle("https://api.anthropic.com/v1/messages"), true);
  assert.equal(shouldHandle("https://api.anthropic.com/v1/messages?beta=true"), true);
  assert.equal(shouldHandle("https://api.anthropic.com/v1/messages/count_tokens"), true);
  assert.equal(shouldHandle("https://api.anthropic.com/v1/models"), false);
});

test("transformBody prunes nothing but injects on a normal message body", async () => {
  const body = JSON.stringify({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
  });
  const out = await transformBody(body, { sessionId: "s" }, new ClaudeAdapter());
  const parsed = JSON.parse(out.body) as { system?: unknown; tools?: Array<{ name: string }> };
  assert.ok(
    Array.isArray(parsed.tools) && parsed.tools.some((t) => t.name === "prune"),
    "prune offered",
  );
  assert.ok(
    JSON.stringify(parsed.system).includes("manage your own context window"),
    "system prompt injected",
  );
});

test("transformBody passes through when there is no session id", async () => {
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal((await transformBody(body, { sessionId: "" }, new ClaudeAdapter())).body, body);
});

test("transformBody passes through a non-JSON or message-less body", async () => {
  const adapter = new ClaudeAdapter();
  assert.equal((await transformBody("not json", { sessionId: "s" }, adapter)).body, "not json");
  const noMsgs = JSON.stringify({ model: "m" });
  assert.equal((await transformBody(noMsgs, { sessionId: "s" }, adapter)).body, noMsgs);
});

test("transformBody applies the same transform to a count_tokens body", async () => {
  // count_tokens shares the request shape; the transform must match so Claude
  // Code counts the pruned transcript it will actually send.
  const body = JSON.stringify({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hello there" }],
  });
  const out = await transformBody(body, { sessionId: "ct" }, new ClaudeAdapter());
  assert.ok(
    JSON.stringify(JSON.parse(out.body)).includes("dcp-message-id"),
    "boundary tag present in counted body",
  );
});

test("transformBody sends the original body and reports the error when apply throws", async () => {
  const errors: unknown[] = [];
  const adapter = {
    apply: async () => {
      throw new Error("engine bug");
    },
    reportError: (error: unknown) => errors.push(error),
  } as unknown as ClaudeAdapter;
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  assert.equal((await transformBody(body, { sessionId: "s" }, adapter)).body, body);
  assert.equal(errors.length, 1);
});

test("transformBody renames nothing for another server's *__prune tool", async () => {
  const body = JSON.stringify({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "mcp__files__prune", description: "d", input_schema: { type: "object" } }],
  });
  const out = await transformBody(body, { sessionId: "other" }, new ClaudeAdapter());
  assert.equal(out.rename, undefined);
  const names = (JSON.parse(out.body) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ["mcp__files__prune", "prune"]);
});

const START =
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":170000,"cache_creation_input_tokens":2000,"output_tokens":1}}}';
const DELTA = 'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":250}}';

test("readUsageLine folds message_start and message_delta usage", () => {
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(readUsageLine(START, usage), true);
  assert.equal(readUsageLine(DELTA, usage), true);
  assert.equal(readUsageLine('data: {"type":"ping"}', usage), false);
  assert.deepEqual(usage, { input: 3, output: 250, cacheRead: 170000, cacheWrite: 2000 });
});

test("the SSE tap reports usage once the stream ends and passes every byte through", () => {
  const seen: Usage[] = [];
  const tap = createSseTap({ onUsage: (usage) => seen.push(usage) });
  const stream = `${START}\n\n${DELTA}\n\n`;
  const out = tap.transform(stream.slice(0, 40)) + tap.transform(stream.slice(40)) + tap.flush();
  assert.equal(out, stream);
  assert.deepEqual(seen, [{ input: 3, output: 250, cacheRead: 170000, cacheWrite: 2000 }]);
});

test("the SSE tap reports usage at message_stop, even if the stream is never flushed", () => {
  const seen: Usage[] = [];
  const tap = createSseTap({ onUsage: (usage) => seen.push(usage) });
  tap.transform(`${START}\n\n${DELTA}\n\ndata: {"type":"message_stop"}\n\n`);
  assert.equal(seen.length, 1);
  tap.flush();
  assert.equal(seen.length, 1);
});
