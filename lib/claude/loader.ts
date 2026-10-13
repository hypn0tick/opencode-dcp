/**
 * Deployment entry for the proxy adapter: the loader that Claude Code's
 * embedded Bun preloads (`boot.ts`, bundled to `dist/claude-loader.mjs`) calls
 * `start()` once at process startup, which builds a `ClaudeAdapter` from
 * environment configuration and installs the fetch interception. `stop()`
 * restores the originals.
 *
 * Options come from the environment because the adapter runs inside Claude
 * Code, which has no plugin-options channel to reach it (unlike OpenCode).
 */

import { ClaudeAdapter } from "./host";
import { installFetchInterception, type RequestObserver } from "./proxy";

/** Reads DCP options from environment variables into `resolveOptions` input. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const dcp: Record<string, unknown> = {};
  const isOff = (v: string | undefined) => v === "0" || v === "false" || v === "off";
  const isOn = (v: string | undefined) => v === "1" || v === "true" || v === "on";
  if (isOff(env.CLAUDE_DCP_ENABLED)) dcp.enabled = false;
  if (isOn(env.CLAUDE_DCP_DEBUG)) dcp.debug = true;
  if (isOn(env.CLAUDE_DCP_ALLOW_SUBAGENTS)) dcp.allowSubAgents = true;
  // A token count or an "NN%" of the model window; resolveOptions parses both.
  if (env.CLAUDE_DCP_MAX_CONTEXT) dcp.maxContextLimit = env.CLAUDE_DCP_MAX_CONTEXT;
  return dcp;
}

/** Claude Code's early-access gate for plugin hooks modules (the prune mod is one). */
const FUNCTION_HOOKS = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";

/**
 * Marks the process as served by a DCP Claude Code loader. Shared by both DCP
 * engines' loaders, so only the first one in a process wraps fetch; two would
 * transform each request twice.
 */
export const ACTIVE = Symbol.for("dcp.claude.loader");

let uninstall: (() => void) | undefined;

/**
 * Installs the interception once. A second call while already installed, or
 * while another DCP loader is active in this process, is a no-op, so a loader
 * that runs again across a reload does not double-wrap. An optional observer is
 * forwarded for logging or metrics.
 *
 * It also turns on Claude Code's function hooks for this process (the loader
 * runs before Claude Code reads the flag), for builds that still gate plugin
 * mods behind early access, so the prune mod loads wherever pruning is live.
 * Where mods load regardless, the mod's own text keeps a call it answers alone
 * honest. Skipped with DCP disabled; a non-empty value the user set is kept.
 */
export function start(observe?: RequestObserver, env: NodeJS.ProcessEnv = process.env): void {
  const global = globalThis as { [ACTIVE]?: string };
  if (uninstall || global[ACTIVE] !== undefined) return;
  const dcp = configFromEnv(env);
  const adapter = new ClaudeAdapter({ dcp });
  uninstall = installFetchInterception(adapter, observe);
  global[ACTIVE] = "arafays";
  if (dcp.enabled !== false && !env[FUNCTION_HOOKS]) env[FUNCTION_HOOKS] = "1";
}

/** Restores the original fetch entry points. Safe to call when not started. */
export function stop(): void {
  if (!uninstall) return;
  uninstall();
  uninstall = undefined;
  delete (globalThis as { [ACTIVE]?: string })[ACTIVE];
}
