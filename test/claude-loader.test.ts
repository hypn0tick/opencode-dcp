import assert from "node:assert/strict";
import { test } from "node:test";

import { configFromEnv, start, stop } from "../lib/claude/loader";

/** The deployment entry: env config mapping and install/restore lifecycle. */

test("configFromEnv maps the DCP environment variables", () => {
  assert.deepEqual(configFromEnv({}), {});
  assert.deepEqual(
    configFromEnv({
      CLAUDE_DCP_ENABLED: "false",
      CLAUDE_DCP_DEBUG: "1",
      CLAUDE_DCP_ALLOW_SUBAGENTS: "true",
      CLAUDE_DCP_MAX_CONTEXT: "70%",
    }),
    { enabled: false, debug: true, allowSubAgents: true, maxContextLimit: "70%" },
  );
});

test("configFromEnv ignores an enabled flag that is not an off value", () => {
  assert.deepEqual(configFromEnv({ CLAUDE_DCP_ENABLED: "1" }), {});
});

const FLAG = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";

/** Runs `start` against an isolated env and returns it, always restoring fetch. */
function started(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  try {
    start(undefined, env);
  } finally {
    stop();
  }
  return env;
}

test("start turns on function hooks so the prune mod loads with the loader", () => {
  assert.equal(started({})[FLAG], "1");
});

test("start treats an empty function-hooks value as unset", () => {
  assert.equal(started({ [FLAG]: "" })[FLAG], "1");
});

test("start keeps a function-hooks value the user set", () => {
  assert.equal(started({ [FLAG]: "0" })[FLAG], "0");
});

test("start leaves function hooks off when DCP is disabled", () => {
  assert.equal(started({ CLAUDE_DCP_ENABLED: "0" })[FLAG], undefined);
});

test("start wraps global fetch once and stop restores it", () => {
  const original = globalThis.fetch;
  try {
    start();
    assert.notEqual(globalThis.fetch, original, "fetch is wrapped after start");
    const wrapped = globalThis.fetch;
    start();
    assert.equal(globalThis.fetch, wrapped, "a second start does not re-wrap");
  } finally {
    stop();
  }
  assert.equal(globalThis.fetch, original, "stop restores the original fetch");
});

test("start stays out of the way while another DCP loader is active", () => {
  const original = globalThis.fetch;
  const key = Symbol.for("dcp.claude.loader");
  const global = globalThis as { [key]?: string };
  global[key] = "tarquinen";
  try {
    start(undefined, {});
    assert.equal(globalThis.fetch, original, "fetch is left unwrapped");
  } finally {
    stop();
    delete global[key];
  }
});
