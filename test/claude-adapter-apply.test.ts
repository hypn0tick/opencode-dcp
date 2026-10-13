import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAdapter } from "../lib/claude/host";
import type { AnthropicRequest } from "../lib/claude/wire";
import { countTokens } from "../lib/tokens";

/**
 * The outcome the adapter exists for: after the model calls `prune` over a
 * range, the next request the adapter sends onward is smaller, and stays
 * smaller on every later request and after a process restart (a fresh adapter
 * with in-memory state, as the deployed loader builds it, replays the call
 * from the transcript). Covers both deployment paths: the proxy alone, where
 * Claude Code answers the bare `prune` with a no-such-tool error, and a no-op
 * mod, whose `mcp__dcp__prune` call carries a clean ack.
 */

type Messages = AnthropicRequest["messages"];

const BULK = Array.from({ length: 400 }, (_, i) => `line ${i}: const value${i} = ${i} * 2`).join(
  "\n",
);
const SUMMARY = "Read src/big.ts and src/b2.ts; both compute 400 values.";
/** The mod's registration and result, as Claude Code puts them on the wire. */
const MOD_TOOL = {
  name: "mcp__dcp__prune",
  description:
    "Unavailable: DCP's proxy, which performs pruning, is not handling this conversation. Do not call this tool.",
  input_schema: { type: "object" },
};
const MOD_RESULT =
  "Handed to DCP. Its proxy replaces this text with the pruning result before the model reads it; a model that receives this text instead must treat the request as not applied: DCP is not active here and nothing was pruned.";

function baseMessages(): Messages {
  return [
    { role: "user", content: "read the two big files" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading the first" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/big.ts" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: BULK }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading the second" },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/b2.ts" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: BULK }] },
    { role: "assistant", content: [{ type: "text", text: "both files compute values" }] },
    { role: "user", content: "now clean up your context" },
  ];
}

/** Token count of the transcript the adapter would send onward. */
function wireTokens(request: AnthropicRequest): number {
  return countTokens(JSON.stringify(request.messages));
}

/** Every boundary id the adapter tagged, in transcript order. */
function refs(request: AnthropicRequest): string[] {
  const text = JSON.stringify(request.messages);
  return [...text.matchAll(/dcp-message-id>\s*([mb]\d+)/g)].map((m) => m[1]!);
}

function pruneTurn(
  name: string,
  startId: string,
  endId: string,
  result: string,
  id = "toolu_prune",
): Messages {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name,
          input: { topic: "big file reads", content: [{ startId, endId, summary: SUMMARY }] },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: result,
          ...(result.startsWith("<tool_use_error>") ? { is_error: true } : {}),
        },
      ],
    },
  ];
}

async function runSession(name: string, result: string, withMod: boolean, sessionId: string) {
  const adapter = new ClaudeAdapter();
  const ctx = { sessionId };
  const request = (messages: Messages): AnthropicRequest => ({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    messages,
    ...(withMod ? { tools: [MOD_TOOL] } : {}),
  });

  const turn1 = baseMessages();
  const ids = refs(await adapter.apply(request(turn1), ctx));
  assert.ok(ids.length >= 2, `adapter tagged no boundary ids: ${JSON.stringify(ids)}`);

  const turn2 = [...turn1, ...pruneTurn(name, ids[0]!, ids[ids.length - 2]!, result)];
  const in2 = request(turn2);
  const out2 = await adapter.apply(in2, ctx);

  const turn3: Messages = [
    ...turn2,
    { role: "assistant", content: [{ type: "text", text: "Pruned." }] },
    { role: "user", content: "Continue." },
  ];
  const in3 = request(turn3);
  const out3 = await adapter.apply(in3, ctx);
  const restarted = await new ClaudeAdapter().apply(in3, ctx);
  return { in2, out2, in3, out3, restarted };
}

for (const [label, name, result, withMod] of [
  [
    "bare prune answered by the harness no-such-tool error",
    "prune",
    "<tool_use_error>Error: No such tool available: prune</tool_use_error>",
    false,
  ],
  ["mod-routed mcp__dcp__prune result", "mcp__dcp__prune", MOD_RESULT, true],
] as const) {
  test(`apply() shrinks the outbound transcript after a ${label}`, async () => {
    const { in2, out2, in3, out3, restarted } = await runSession(
      name,
      result,
      withMod,
      `apply-${name}`,
    );
    const before2 = wireTokens(in2);
    const before3 = wireTokens(in3);

    assert.ok(
      wireTokens(out2) < before2 / 3,
      `request after prune not pruned: ${before2} -> ${wireTokens(out2)}`,
    );
    assert.ok(
      wireTokens(out3) < before3 / 3,
      `pruning did not persist: ${before3} -> ${wireTokens(out3)}`,
    );
    assert.ok(
      wireTokens(restarted) < before3 / 3,
      `pruning lost on a fresh adapter: ${before3} -> ${wireTokens(restarted)}`,
    );
    for (const out of [out3, restarted]) {
      const text = JSON.stringify(out.messages);
      assert.ok(!text.includes("line 399: const value399"), "pruned bulk still on the wire");
      assert.ok(text.includes("both compute 400 values"), "summary missing from the wire");
    }
    for (const out of [out2, out3, restarted]) {
      const text = JSON.stringify(out.messages);
      assert.ok(!text.includes("No such tool available"), "harness error reached the model");
      assert.ok(!text.includes("nothing was pruned"), "mod fallback reached the model");
      assert.ok(
        !JSON.stringify(out.tools).includes("Unavailable:"),
        "mod definition reached the model",
      );
    }
  });
}

test("a fresh adapter replays chained prunes from history in order", async () => {
  const bulk = (tag: string) =>
    Array.from({ length: 400 }, (_, i) => `${tag} line ${i}: const v${i} = ${i}`).join("\n");
  const read = (id: string, tag: string): Messages => [
    {
      role: "assistant",
      content: [
        { type: "text", text: `reading ${tag}` },
        { type: "tool_use", id, name: "Read", input: { file_path: tag } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: bulk(tag) }] },
  ];
  const harnessError = "<tool_use_error>Error: No such tool available: prune</tool_use_error>";
  const request = (messages: Messages): AnthropicRequest => ({
    model: "claude-opus-4-8",
    messages,
  });
  const adapter = new ClaudeAdapter();
  const ctx = { sessionId: "apply-chained" };

  let messages: Messages = [
    { role: "user", content: "go" },
    ...read("r1", "AAA"),
    { role: "user", content: "more" },
  ];
  const first = refs(await adapter.apply(request(messages), ctx));
  messages = [
    ...messages,
    ...pruneTurn("prune", first[0]!, first[first.length - 2]!, harnessError, "toolu_p1"),
    ...read("r2", "BBB"),
    { role: "user", content: "again" },
  ];
  const second = refs(await adapter.apply(request(messages), ctx));
  assert.ok(second.includes("b1"), `the first prune's block is not addressable: ${second}`);
  messages = [
    ...messages,
    ...pruneTurn("prune", second[0]!, second[second.length - 2]!, harnessError, "toolu_p2"),
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "fin" },
  ];

  const before = wireTokens(request(messages));
  const restarted = await new ClaudeAdapter().apply(request(messages), ctx);
  const text = JSON.stringify(restarted.messages);
  assert.ok(
    wireTokens(restarted) < before / 3,
    `chained replay not pruned: ${before} -> ${wireTokens(restarted)}`,
  );
  assert.ok(!text.includes("AAA line 399") && !text.includes("BBB line 399"));
  assert.ok(!text.includes("Prune not applied"), "a replayed prune failed");
});

const BREAKPOINT = { type: "ephemeral", ttl: "1h" };

/** Claude Code's trailing reminder; only the newest copy carries the cache breakpoint. */
function reminder(marked: boolean): Messages[number] {
  const text = "<total_tokens>9</total_tokens>";
  return marked
    ? { role: "system", content: [{ type: "text", text, cache_control: BREAKPOINT }] }
    : { role: "system", content: text };
}

/** Claude Code's shape: hook output as system messages, the breakpoint on a trailing reminder. */
function withHooks(messages: Messages): Messages {
  return [
    messages[0]!,
    { role: "system", content: "SessionStart hook additional context: be terse." },
    ...messages.slice(1),
    reminder(true),
  ];
}

/** The next request: the old reminder stays unmarked, the new turn and reminder follow. */
function nextTurn(previous: Messages, added: Messages): Messages {
  return [...previous.slice(0, -1), reminder(false), ...added, reminder(true)];
}

/** A message as the cache sees it: string content as one text block, breakpoints ignored. */
function unmarked(message: Messages[number]): string {
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  return JSON.stringify({ ...message, content }, (key, value) =>
    key === "cache_control" ? undefined : value,
  );
}

/** Indexes of the messages that carry a cache breakpoint. */
function markerIndexes(messages: Messages): number[] {
  return messages.flatMap((m, i) =>
    JSON.stringify(m.content).includes("cache_control") ? [i] : [],
  );
}

/** A request carrying only the transcript under test. */
function request(messages: Messages): AnthropicRequest {
  return { model: "claude-opus-4-8", messages };
}

test("apply() keeps hook system messages and the message cache breakpoint", async () => {
  const adapter = new ClaudeAdapter();
  const ctx = { sessionId: "apply-cache" };
  const turn1 = withHooks(baseMessages());
  const out1 = await adapter.apply(request(turn1), ctx);

  assert.equal(out1.messages.filter((m) => m.role === "system").length, 2);
  assert.deepEqual(markerIndexes(out1.messages), [out1.messages.length - 1]);
  assert.deepEqual(out1.messages[out1.messages.length - 1], turn1[turn1.length - 1]);

  const turn2 = nextTurn(turn1, [
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "thanks" },
  ]);
  const out2 = await adapter.apply(request(turn2), ctx);

  assert.deepEqual(markerIndexes(out2.messages), [out2.messages.length - 1]);
  const cached = markerIndexes(out1.messages)[0]!;
  for (let i = 0; i <= cached; i++) {
    assert.equal(
      unmarked(out2.messages[i]!),
      unmarked(out1.messages[i]!),
      `request 2 changes cached prefix message ${i}`,
    );
  }
});

test("apply() keeps the cache breakpoint after a prune", async () => {
  const adapter = new ClaudeAdapter();
  const ctx = { sessionId: "apply-cache-prune" };
  const turn1 = withHooks(baseMessages());
  const ids = refs(await adapter.apply(request(turn1), ctx));
  const harnessError = "<tool_use_error>Error: No such tool available: prune</tool_use_error>";
  const turn2 = nextTurn(turn1, pruneTurn("prune", ids[0]!, ids[ids.length - 2]!, harnessError));
  const out2 = await adapter.apply(request(turn2), ctx);

  assert.ok(!JSON.stringify(out2.messages).includes("line 399: const value399"));
  const marked = markerIndexes(out2.messages);
  assert.equal(marked.length, 1);
  assert.deepEqual(out2.messages[marked[0]!], turn2[turn2.length - 1]);
});

test("apply() never tags or prunes the first user message and keeps hook messages", async () => {
  const adapter = new ClaudeAdapter();
  const ctx = { sessionId: "apply-pinned" };
  const turn1 = withHooks(baseMessages());
  const out1 = await adapter.apply(request(turn1), ctx);
  assert.deepEqual(out1.messages[0], turn1[0]);

  const ids = refs(out1);
  const harnessError = "<tool_use_error>Error: No such tool available: prune</tool_use_error>";
  const turn2 = nextTurn(turn1, pruneTurn("prune", ids[0]!, ids[ids.length - 2]!, harnessError));
  const out2 = await adapter.apply(request(turn2), ctx);

  assert.ok(!JSON.stringify(out2.messages).includes("line 399: const value399"));
  assert.deepEqual(out2.messages.slice(0, 2), turn1.slice(0, 2));
  assert.equal(
    out2.messages.filter((m) => m.role === "system").length,
    turn2.filter((m) => m.role === "system").length,
  );
});

test("apply() sizes context from the API's reported usage, cache included", async () => {
  const nudged = (out: AnthropicRequest) => JSON.stringify(out.messages).includes("prune now.");
  const quiet = new ClaudeAdapter();
  assert.equal(nudged(await quiet.apply(request(baseMessages()), { sessionId: "usage-0" })), false);

  const reported = new ClaudeAdapter();
  reported.recordUsage("usage-1", { input: 3, output: 200, cacheRead: 170_000, cacheWrite: 2_000 });
  assert.equal(
    nudged(await reported.apply(request(baseMessages()), { sessionId: "usage-1" })),
    true,
  );
});
