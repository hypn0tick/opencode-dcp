# Claude Code adapter

Runs this plugin's Dynamic Context Pruning inside
[Claude Code](https://claude.com/claude-code) instead of OpenCode. The DCP engine (`lib/transform.ts`, `lib/prune-tool.ts`,
`lib/state/`, the prompts) is reused as-is; this adapter only converts between
Claude Code's wire format and the transcript shape the engine expects, and
supplies the small host contract the engine needs. No engine file is changed.

## How it works

Claude Code talks to the Anthropic Messages API over HTTP. The adapter is a
**proxy on that wire**: a loader that Claude Code's embedded Bun preloads wraps
`fetch`/`Bun.FetchSession`, and every `/v1/messages` request (and
`/v1/messages/count_tokens`, so context sizing and auto-compaction stay in
sync) is run through `ClaudeAdapter`:

1. `wire.ts` converts the request's `messages`/`system` to the engine's
   `WireMessage[]`/`SystemPart[]` (lossless and byte-identical for anything the
   engine does not touch). `tool_result` blocks become `role:"tool"` messages,
   `thinking` keeps its signature, unmodeled blocks round-trip verbatim.
   Claude Code's mid-conversation `role:"system"` messages (hook output and
   reminders, the last of which carries its message cache breakpoint) stay out
   of the pipeline, and the first user message (CLAUDE.md and memory context)
   always goes out as sent, so neither can be pruned and the cached prefix
   holds.
2. `host.ts` runs the engine's `createContextHook` over the converted
   transcript and routes any `prune` tool call to the engine's own
   `pruneToolDefinition(...).execute`.
3. The edited transcript is converted back and sent onward. If the adapter
   throws, the original request goes out instead. Responses are forwarded
   untouched **except** the one rename described below; `usage` is read, never
   rewritten: each main response's reported input, cache-read and cache-write
   tokens feed the engine's `UsageTracker`, so the nudges size context from what
   the API counted, system prompt and tools included.

Everything is outbound-only and per-session state is injectable
(`AdapterOptions.storage`), so the adapter bundles standalone (its import
closure pulls in only `node:` builtins). Only one DCP loader (of either DCP
engine) wraps `fetch` in a process.

### The prune tool and the mod

The engine drives pruning by offering the model a `prune` tool and reading the
calls it makes. The adapter offers that tool on the wire. With the proxy alone,
the engine answers the model's `prune` call with a recoverable
`<tool_use_error>` (no such tool) that the adapter rewrites to the ack on the
next request — pruning works, but the transcript shows a failed-looking call.

The plugin's **mod** (`mods/prune/`), which also stages the loader (see
Install), removes that blemish. Because a
Claude Code mod can only register a namespaced `mcp__dcp__prune`, while the
engine's prompts name the tool `prune`, the adapter bridges the two names on the
wire (`prune-router.ts`, `proxy.ts`):

- **request:** offer the engine's canonical `prune` under its bare name,
  rewriting the mod's registered `mcp__dcp__prune` entry in place — the model
  sees `prune` and follows the unmodified prompts.
- **response:** rename the model's `prune` tool_use back to `mcp__dcp__prune` in
  the SSE stream, so the engine routes the call to the mod. Only the tool_use
  name is touched.

The mod's own description and result are written for the one case where the
model reads them: a process where the proxy is not handling the request (no
loader, or a sub-agent the adapter skips). The description says the tool is
unavailable and the result says nothing was pruned, so a mod loaded without
the proxy never reports a false success. Where the proxy runs, it replaces
both before the model sees them; the user's transcript always shows the mod's
result text.

## Install

The npm package is also the Claude Code plugin: its root carries
`.claude-plugin/plugin.json`, which points at `mods/prune/` (the mod and the
`/dcp:dcp` and `/dcp:dcp-prune` commands), and `npm run build` bundles the
loader to `dist/claude-loader.mjs`. The repository's
`.claude-plugin/marketplace.json` installs it from npm:

```bash
claude plugin marketplace add arafays/opencode-dcp
claude plugin install dcp@claude-dcp-arafays
```

It needs Claude Code 2.1.287 or later, where plugin mods load by default; on an
earlier build, set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` once. Nothing else is
required: no Node, and no binary patch.

At session start the mod copies the packaged loader to a version-independent
dir (`$XDG_DATA_HOME` or `%LOCALAPPDATA%`, under `claude-dcp-arafays`) and adds
a `--preload` for it to `BUN_OPTIONS`: User scope on Windows (through
PowerShell), a `~/.config/environment.d/60-claude-dcp-arafays.conf` file on
Linux (apps started from the desktop session, from the next login; SSH and
console shells need the profile line the status shows), and launchd's
environment plus a login agent on macOS (the agent re-applies it at each login,
and only while the staged loader exists). It runs in-process with the OS's own
tools and spawns nothing once the loader is staged and active. Claude Code's
embedded Bun loads the loader from the next launch, so restart Claude Code once
after installing; until then the status line says DCP is not active. The mod restages whenever the packaged loader differs from the staged
copy, which is how plugin updates reach it, and Claude Code updates need
nothing, since the preload is not a binary patch.

Uninstalling the plugin is picked up by the loader itself
(`lib/claude/selfclean.ts`), which removes its `--preload` once Claude Code's
install registry shows the plugin gone from every scope; disabling it, or a
project where it is not installed, just leaves DCP off there. The staged loader
stays, since a `--preload` naming a missing file stops Claude Code from
starting. `node mods/prune/scripts/uninstall.mjs` (from the installed plugin
dir, and the one piece that needs Node) removes the token and then the staged
dir, once no environment it can see still names the loader.

## Configuration

Options come from the environment (Claude Code has no plugin-options channel):

| Variable | Effect |
| --- | --- |
| `CLAUDE_DCP_ENABLED=0` | Disable the adapter (pass through untouched). |
| `CLAUDE_DCP_DEBUG=1` | Verbose logging. |
| `CLAUDE_DCP_ALLOW_SUBAGENTS=1` | Also prune sub-agent sessions. |
| `CLAUDE_DCP_MAX_CONTEXT` | Token count or `NN%` of the model window. |

## Tests

`npm test` covers the converter, the host pipeline, the prune routing, the
proxy, the tool/result pairing invariant, the name-bridge, the loader, the
self-guard, and the outcome itself: `test/claude-adapter-apply.test.ts` drives
`ClaudeAdapter.apply()` through a prune call and asserts the outbound
transcript shrinks and stays shrunk, including on a fresh adapter replaying the
call after a restart (`test/claude-*.test.ts`). The mod (`mods/prune/`) imports
the `claude-code` mod API, so it sits outside the plugin's `tsconfig` and is not
part of `aube`/CI; it ships in the npm package without its test. Validate it
with `claude plugin test mods/prune` (on builds that still gate mods, set
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`), and the plugin with
`claude plugin validate .claude-plugin/plugin.json`.
