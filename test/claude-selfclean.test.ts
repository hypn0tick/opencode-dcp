import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PLUGIN_ID,
  enabledInSettings,
  guard,
  installedAnywhere,
  psQuote,
} from "../lib/claude/selfclean";

/**
 * The preload's self-guard decides from Claude's settings whether the plugin is
 * still installed and enabled. These pin the four outcomes, and that missing or
 * unreadable settings never read as an uninstall (which would strip the token).
 */

/** A temp user config dir and project dir, each with an optional settings file. */
function dirs(settings?: string, project?: string): { config: string; cwd: string } {
  const config = mkdtempSync(join(tmpdir(), "dcp-selfclean-config-"));
  const cwd = mkdtempSync(join(tmpdir(), "dcp-selfclean-cwd-"));
  if (settings !== undefined) writeFileSync(join(config, "settings.json"), settings);
  if (project !== undefined) {
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), project);
  }
  return { config, cwd };
}

const plugins = (value: unknown) => JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: value } });

test("an enabled key in any scope means run", () => {
  const { config, cwd } = dirs(JSON.stringify({}), plugins(true));
  assert.equal(enabledInSettings(config, cwd), "yes");
});

test("a key set false means disabled", () => {
  const { config, cwd } = dirs(plugins(false));
  assert.equal(enabledInSettings(config, cwd), "no");
});

test("readable settings without the key mean uninstalled", () => {
  const { config, cwd } = dirs(JSON.stringify({ enabledPlugins: { "other@market": true } }));
  assert.equal(enabledInSettings(config, cwd), "absent");
});

test("missing or unreadable settings are uncertain, never a removal signal", () => {
  const missing = dirs();
  assert.equal(enabledInSettings(missing.config, missing.cwd), "error");
  const broken = dirs("{ not json");
  assert.equal(enabledInSettings(broken.config, broken.cwd), "error");
});

test("the guard skips outside a Claude Code standalone", () => {
  assert.equal(guard(), "skip");
});

/** A temp config dir whose install registry lists the given plugins. */
function registry(plugins: unknown): string {
  const config = mkdtempSync(join(tmpdir(), "dcp-selfclean-registry-"));
  mkdirSync(join(config, "plugins"));
  writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  return config;
}

test("a plugin in the install registry is installed, whatever scope it is in", () => {
  const entry = [{ scope: "project", projectPath: "/repo/a" }];
  assert.equal(installedAnywhere(registry({ [PLUGIN_ID]: entry })), true);
  assert.equal(installedAnywhere(registry({ "other@market": entry })), false);
});

test("an unreadable install registry never reads as uninstalled", () => {
  assert.equal(installedAnywhere(mkdtempSync(join(tmpdir(), "dcp-selfclean-none-"))), true);
});

test("psQuote makes a PowerShell literal of any value", () => {
  assert.equal(psQuote("--smol --preload=C:/x"), "'--smol --preload=C:/x'");
  assert.equal(psQuote("it's"), "'it''s'");
});
