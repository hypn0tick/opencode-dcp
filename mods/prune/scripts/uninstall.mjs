/**
 * Removes what the prune mod set up: the `--preload` token from where it was
 * persisted (User BUN_OPTIONS on Windows, launchd's environment and the login
 * agent on macOS, the environment.d file on Linux), then the staged loader dir.
 * The loader also strips its own token once the plugin is uninstalled in every
 * scope; this is the explicit path. Run it with
 * `node <plugin root>/mods/prune/scripts/uninstall.mjs`.
 *
 * A `--preload` naming a missing file stops Claude Code (and any Bun program)
 * from starting, so the staged dir is removed only once no environment this
 * script can see still carries the token; otherwise it says to run it again.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

function stableDir() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (IS_WIN
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : join(homedir(), ".local", "share"));
  return join(dataHome, "claude-dcp-arafays");
}

/** The whitespace-separated entries of an env value such as BUN_OPTIONS. */
const words = (value) => (value ?? "").split(/\s+/).filter((entry) => entry.length > 0);
/** A PowerShell single-quoted string literal. */
const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;

const dir = stableDir();
const token = `--preload=${join(dir, "claude-loader.mjs").replace(/\\/g, "/")}`;

/** Removes the persisted token; returns true when the persisted setting is free of it. */
function removePersisted() {
  if (IS_WIN) {
    const read = () =>
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('BUN_OPTIONS','User')"],
        { encoding: "utf8" },
      );
    const parts = words(read());
    if (parts.includes(token)) {
      const next = parts.filter((entry) => entry !== token).join(" ");
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `[Environment]::SetEnvironmentVariable('BUN_OPTIONS', ${next ? psQuote(next) : "$null"}, 'User')`,
      ]);
      console.log("Removed the DCP preload from User BUN_OPTIONS.");
    }
    return !words(read()).includes(token);
  }
  if (IS_MAC) {
    rmSync(join(homedir(), "Library", "LaunchAgents", "com.dcp.claude-arafays.plist"), {
      force: true,
    });
    const parts = words(execFileSync("launchctl", ["getenv", "BUN_OPTIONS"], { encoding: "utf8" }));
    if (parts.includes(token)) {
      const next = parts.filter((entry) => entry !== token).join(" ");
      if (next) execFileSync("launchctl", ["setenv", "BUN_OPTIONS", next]);
      else execFileSync("launchctl", ["unsetenv", "BUN_OPTIONS"]);
      console.log("Removed the DCP preload from launchd's BUN_OPTIONS and its login agent.");
    }
    return true;
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  rmSync(join(configHome, "environment.d", "60-claude-dcp-arafays.conf"), { force: true });
  console.log("Removed the DCP environment.d file; it stops applying at your next login.");
  return true;
}

let persistedClear = false;
try {
  persistedClear = removePersisted();
} catch (error) {
  console.error(
    "Could not update BUN_OPTIONS:",
    error instanceof Error ? error.message : String(error),
  );
}

if (persistedClear && !words(process.env.BUN_OPTIONS).includes(token)) {
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log("Removed the staged loader dir:", dir);
  } catch {
    // Nothing to remove.
  }
  console.log("Restart Claude Code for the change to take effect.");
} else {
  if (!IS_WIN && !IS_MAC) {
    console.log(`Remove ${token} from BUN_OPTIONS in your shell profile if you added it there.`);
  }
  console.log(
    `The staged loader stays in ${dir} while BUN_OPTIONS still names it. Open a new terminal (on Linux, log out and back in), then run this script again to remove it.`,
  );
}
