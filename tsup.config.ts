import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: ["index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    // `npm run build` empties dist first; cleaning here would race the loader build.
    clean: false,
    target: "es2022",
    platform: "node",
  },
  // The loader: one self-contained file Claude Code's embedded Bun preloads at
  // startup. The adapter closure imports only node builtins, so the local lib
  // bundles whole and nothing from node_modules is left external. No top-level
  // await, so the preload finishes before Claude Code's main code runs.
  {
    entry: { "claude-loader": "lib/claude/boot.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    clean: false,
    target: "es2022",
    platform: "node",
    outExtension: () => ({ js: ".mjs" }),
  },
])
