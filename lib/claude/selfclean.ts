/**
 * Preload self-guard, bundled into `dist/claude-loader.mjs` and consulted by every
 * process that loads the preload.
 *
 * Two responsibilities, both aimed at never harming the machine:
 *   1. Scope. Run DCP only in a real Claude Code standalone main process. A plain
 *      `bun run` or a worker thread that inherits BUN_OPTIONS is a no-op, so a
 *      stale token can never disturb other Bun work.
 *   2. Self-clean. Claude Code has no uninstall hook, so uninstalling the plugin
 *      cannot itself clear the persisted `--preload`. Once Claude Code's install
 *      registry shows the plugin uninstalled in every scope, the guard removes
 *      its token from where the prune mod persisted it: User BUN_OPTIONS on
 *      Windows, the `environment.d` file on Linux, launchd's environment and the
 *      login agent on macOS. The staged loader is never deleted meanwhile, since
 *      a `--preload` naming a missing file stops Claude Code from starting.
 *
 * Whether to run comes from this project's settings: enabled runs, disabled or
 * absent skips. A plugin installed for another project is absent here, which is
 * why only the registry, not these settings, decides an uninstall; missing or
 * unreadable files are unknown and never self-clean.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

/**
 * The install id the plugin's marketplace gives it. Keep it, the staging dir and
 * the POSIX persistence names in sync with `mods/prune/hooks/register.ts`.
 */
export const PLUGIN_ID = "dcp@claude-dcp-arafays";
const LINUX_ENV_FILE = "60-claude-dcp-arafays.conf";
const MAC_AGENT = "com.dcp.claude-arafays";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

/** The version-independent dir the prune mod stages the loader into. */
export function stableDir(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (IS_WIN
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : join(homedir(), ".local", "share"));
  return join(dataHome, "claude-dcp-arafays");
}

function loaderToken(): string {
  return `--preload=${join(stableDir(), "claude-loader.mjs").replace(/\\/g, "/")}`;
}

/** A PowerShell single-quoted string literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** True only in a Claude Code standalone's main thread. */
function isClaudeMain(): boolean {
  try {
    const bun = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun;
    if (!bun?.isStandaloneExecutable || !isMainThread) return false;
    return /(^|[\\/])claude(\.exe)?$/i.test(process.execPath || "");
  } catch {
    return false;
  }
}

/** This plugin's state in Claude's settings; "error" when no scope is readable. */
export type Enabled = "yes" | "no" | "absent" | "error";

/** Reads this plugin's enabled state from the user and project settings scopes. */
export function enabledInSettings(
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  cwd = process.cwd(),
): Enabled {
  const files = [
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  let anyReadable = false;
  let sawKey = false;
  for (const file of files) {
    if (!existsSync(file)) continue;
    let map: Record<string, boolean> | undefined;
    try {
      map = (JSON.parse(readFileSync(file, "utf8")) as { enabledPlugins?: Record<string, boolean> })
        .enabledPlugins;
    } catch {
      return "error";
    }
    anyReadable = true;
    if (map && PLUGIN_ID in map) {
      sawKey = true;
      if (map[PLUGIN_ID] === true) return "yes";
    }
  }
  if (!anyReadable) return "error";
  return sawKey ? "no" : "absent";
}

/**
 * Whether Claude Code's install registry (`plugins/installed_plugins.json`)
 * still lists the plugin in any scope. An unreadable registry counts as
 * installed, so uncertainty never self-cleans.
 */
export function installedAnywhere(
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): boolean {
  try {
    const registry = JSON.parse(
      readFileSync(join(configDir, "plugins", "installed_plugins.json"), "utf8"),
    ) as { plugins?: Record<string, unknown> };
    const entry = registry.plugins?.[PLUGIN_ID];
    return Array.isArray(entry) ? entry.length > 0 : entry !== undefined;
  } catch {
    return true;
  }
}

/** The whitespace-separated entries of an env value such as BUN_OPTIONS. */
function words(value: string): string[] {
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}

/** CLAUDE_DCP_SELFCLEAN_DRY=1 records what self-clean would do instead of doing it. */
function recordDry(line: string): void {
  writeFileSync(join(stableDir(), "selfclean-dry.out"), `${line}\n`, { flag: "a" });
}

/** Removes this plugin's `--preload` token from where the prune mod persisted it. */
export function stripOwnToken(): void {
  const token = loaderToken();
  const dry = process.env.CLAUDE_DCP_SELFCLEAN_DRY === "1";
  try {
    if (IS_WIN) {
      const parts = words(
        execFileSync(
          "powershell",
          ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('BUN_OPTIONS','User')"],
          { encoding: "utf8" },
        ),
      );
      if (!parts.includes(token)) return;
      const next = parts.filter((entry) => entry !== token).join(" ");
      if (dry) return recordDry(`would set BUN_OPTIONS=[${next}]`);
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `[Environment]::SetEnvironmentVariable('BUN_OPTIONS', ${next ? psQuote(next) : "$null"}, 'User')`,
      ]);
    } else if (IS_MAC) {
      const agent = join(homedir(), "Library", "LaunchAgents", `${MAC_AGENT}.plist`);
      const parts = words(execFileSync("launchctl", ["getenv", "BUN_OPTIONS"], { encoding: "utf8" }));
      const next = parts.filter((entry) => entry !== token).join(" ");
      if (dry) return recordDry(`would remove ${agent} and set launchd BUN_OPTIONS=[${next}]`);
      rmSync(agent, { force: true });
      if (!parts.includes(token)) return;
      if (next) execFileSync("launchctl", ["setenv", "BUN_OPTIONS", next]);
      else execFileSync("launchctl", ["unsetenv", "BUN_OPTIONS"]);
    } else {
      const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
      const file = join(configHome, "environment.d", LINUX_ENV_FILE);
      if (dry) return recordDry(`would remove ${file}`);
      rmSync(file, { force: true });
    }
  } catch {
    // Best effort; the loader file is never deleted, so nothing dangles regardless.
  }
}

/**
 * "start" runs the adapter; "skip" leaves Claude Code untouched. Strips the
 * preload token only once the plugin is uninstalled in every scope; disabled
 * or absent in this project just skips.
 */
export function guard(): "start" | "skip" {
  try {
    if (!isClaudeMain()) return "skip";
    const enabled = enabledInSettings();
    if (enabled === "yes" || enabled === "error") return "start";
    if (!installedAnywhere()) stripOwnToken();
    return "skip";
  } catch {
    return "start";
  }
}
