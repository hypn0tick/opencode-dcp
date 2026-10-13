import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** The installable plugin's manifest must carry the npm package's version. */
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("the Claude Code plugin version matches the npm package version", () => {
  assert.equal(json("../.claude-plugin/plugin.json").version, json("../package.json").version);
});
