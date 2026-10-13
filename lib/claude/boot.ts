/**
 * Standalone entry Claude Code loads once at startup, as a Bun preload staged by
 * the plugin's prune mod at session start (`mods/prune/hooks/register.ts`). It
 * asks the self-guard whether this process should run DCP, then calls the
 * adapter's `start()` to install the fetch interception and gets out of the way.
 * Any fault here is swallowed: a loader that throws must never break the CLI,
 * and with the interception not installed, model requests simply pass through
 * untransformed.
 *
 * `npm run build` bundles it to `dist/claude-loader.mjs` (self-contained; only
 * node builtins stay external), with no top-level await so it loads fully
 * before Claude Code's `main` runs. The npm package ships it, and the package
 * root is the Claude Code plugin.
 */

import { start } from "./index";
import { guard } from "./selfclean";

try {
  if (guard() === "start") start();
} catch {
  // Never let a loader fault break the host; requests pass through untransformed.
}
