import { expect, mock, test } from "claude-code/testing";

/**
 * The mod answers a prune call with text that is true on its own (nothing was
 * pruned unless the proxy replaces it), and at session start stages the loader
 * without Node: every mods API call it makes is stubbed here, so these pin which
 * OS commands it runs, that an already staged and active loader spawns nothing,
 * that a dry run never changes BUN_OPTIONS, and what the status line says.
 */

const WIN = { OS: "Windows_NT", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
const TOKEN = "--preload=C:/Users/u/AppData/Local/claude-dcp-arafays/claude-loader.mjs";
const LOADER = /[\\/]dist[\\/]claude-loader\.mjs$/;

interface Stage {
  env: Record<string, string>;
  exists?: (path: string) => boolean;
  staged?: boolean;
  userEnv?: string;
  kernel?: string;
}

type On = Parameters<Parameters<typeof test>[1]>[1];

/** Stubs every mods API call the session.start hook makes and records them. */
function stub(on: On, stage: Stage) {
  const runs: string[] = [];
  const statuses: string[] = [];
  const writes: string[] = [];
  mock.env(on, stage.env);
  on("tool.register", () => ({ value: undefined }));
  on("session.start", () => ({ cwd: "/work" }));
  on("fs.exists", (_$, e) => {
    const path = String((e as { path?: unknown }).path ?? JSON.stringify(e));
    return { value: (stage.exists ?? (() => true))(path) };
  });
  // The packaged loader reads as a newer build unless the stage is current.
  on("fs.read", (_$, e) => {
    const packaged = LOADER.test(String((e as { path?: unknown }).path ?? JSON.stringify(e)));
    return { value: packaged && !stage.staged ? "loader v2" : "loader v1" };
  });
  on("fs.write", (_$, e) => {
    writes.push(JSON.stringify(e));
    return { value: undefined };
  });
  on("process.run", (_$, e) => {
    const call = JSON.stringify(e);
    runs.push(call);
    const stdout = call.includes("GetEnvironmentVariable")
      ? (stage.userEnv ?? "")
      : call.includes("uname")
        ? (stage.kernel ?? "Linux")
        : "";
    return { value: { exitCode: 0, stdout, stderr: "" } };
  });
  on("ui.status", (_$, e) => {
    statuses.push(JSON.stringify(e));
    return { value: undefined };
  });
  return { runs, statuses, writes };
}

const start = { surface: "terminal", isInteractive: true, cwd: "/work" };
const notMarker = (path: string) => !path.includes("active.json");

test("answers a prune call with text that says nothing was pruned unless the proxy replaces it", async ($) => {
  const result = await $.tool.call({ tool: "mcp__dcp__prune", topic: "demo", content: [] });
  expect(JSON.stringify(result)).toContain("nothing was pruned");
});

test("a first start stages the loader and adds its preload to User BUN_OPTIONS", async ($, on) => {
  const seen = stub(on, { env: WIN, exists: notMarker, userEnv: "--smol" });
  await $.session.start(start);
  expect(seen.runs.some((r) => r.includes("Copy-Item") && r.includes("claude-loader.mjs"))).toBe(
    true,
  );
  expect(seen.writes.join()).toContain("pluginRoot");
  expect(seen.runs.find((r) => r.includes("SetEnvironmentVariable"))).toContain(`--smol ${TOKEN}`);
  expect(seen.statuses.join()).toContain("restart Claude Code");
});

test("a staged, active loader spawns nothing and stays quiet", async ($, on) => {
  const seen = stub(on, { env: { ...WIN, BUN_OPTIONS: TOKEN }, staged: true });
  await $.session.start(start);
  expect(seen.runs).toEqual([]);
  expect(seen.statuses).toEqual([]);
});

test("an update restages even when it installs to the same plugin dir", async ($, on) => {
  const seen = stub(on, { env: { ...WIN, BUN_OPTIONS: TOKEN } });
  await $.session.start(start);
  expect(seen.runs.some((r) => r.includes("Copy-Item"))).toBe(true);
  expect(seen.statuses).toEqual([]);
});

test("dry run stages but never changes BUN_OPTIONS", async ($, on) => {
  const seen = stub(on, { env: { ...WIN, CLAUDE_DCP_DRY: "1" }, exists: notMarker });
  await $.session.start(start);
  expect(seen.runs.some((r) => r.includes("SetEnvironmentVariable"))).toBe(false);
  expect(seen.statuses.join()).toContain("DCP DRY");
});

test("a package without a built loader says DCP is not active", async ($, on) => {
  const seen = stub(on, { env: WIN, exists: () => false });
  await $.session.start(start);
  expect(seen.runs).toEqual([]);
  expect(seen.statuses.join()).toContain("no built loader");
});

const POSIX_TOKEN = "--preload=/home/u/.local/share/claude-dcp-arafays/claude-loader.mjs";

test("on Linux it stages with cp and writes an environment.d file", async ($, on) => {
  const seen = stub(on, { env: { HOME: "/home/u" }, exists: notMarker });
  await $.session.start(start);
  expect(seen.runs.some((r) => r.includes("cp -f"))).toBe(true);
  const file = seen.writes.find((w) => w.includes("60-claude-dcp-arafays.conf"));
  expect(file).toMatch(/home.+u.+\.config.+environment\.d/);
  expect(file).toContain(JSON.stringify(`"\${BUN_OPTIONS:+$BUN_OPTIONS }${POSIX_TOKEN}"`).slice(1, -1));
  expect(seen.statuses.join()).toContain("log out and back in");
});

test("on macOS it sets launchd's BUN_OPTIONS and writes a login agent", async ($, on) => {
  const seen = stub(on, { env: { HOME: "/Users/u" }, exists: notMarker, kernel: "Darwin" });
  await $.session.start(start);
  const plist = seen.writes.find((w) => w.includes("com.dcp.claude-arafays.plist"));
  expect(plist).toMatch(/Users.+u.+Library.+LaunchAgents/);
  expect(plist).toContain("RunAtLoad");
  expect(seen.runs.some((r) => r.includes("launchctl setenv BUN_OPTIONS"))).toBe(true);
  expect(seen.statuses.join()).toContain("quit and reopen Claude Code");
});
