/**
 * The DCP mod. It answers the model's prune call and stages the loader; the
 * adapter's wire proxy, which that loader installs, does the pruning itself.
 *
 * The proxy offers the model opencode-dcp's own `prune` tool on the wire and
 * renames the model's `prune` call to this plugin's namespaced `mcp__dcp__prune`
 * in the response, so the engine routes it to the handler below. The handler
 * only answers the call; the compression itself runs in the proxy's outbound
 * transform on the following request, keyed by the call, which also replaces
 * this mod's result with the real outcome.
 *
 * So the model reads this mod's own description and result only where the
 * proxy is not handling the request (no loader in the process, a sub-agent the
 * adapter skips), and both say that nothing will be pruned. The user's
 * transcript always shows the result text, which is why it reads correctly in
 * both cases.
 *
 * At session start the mod also stages the packaged loader
 * (`dist/claude-loader.mjs`) into a version-independent dir and adds its
 * `--preload` to User BUN_OPTIONS, so Claude Code's embedded Bun loads it from
 * the next launch. It runs in-process and uses the OS's own tools (PowerShell on
 * Windows, `sh` elsewhere), so no Node is needed; the common path, already
 * staged and active, spawns nothing. The env changes only after the staged file
 * is verified, so the `--preload` never names a missing loader. When DCP is not
 * active in this process the status line says why. CLAUDE_DCP_DRY=1 stages but
 * never changes BUN_OPTIONS. Keep PLUGIN_ID and the staging dir in sync with
 * `lib/claude/selfclean.ts`.
 */

import type { Register } from "claude-code";

/** The plugin is named `dcp` (plugin.json), so its tool is `mcp__dcp__prune`. */
const TOOL = "mcp__dcp__prune";
const PLUGIN_ID = "dcp@claude-dcp-arafays";
const RESULT =
  "Handed to DCP. Its proxy replaces this text with the pruning result before the model reads it; a model that receives this text instead must treat the request as not applied: DCP is not active here and nothing was pruned.";

/** The POSIX persistence `lib/claude/selfclean.ts` and `scripts/uninstall.mjs` remove. */
const LINUX_ENV_FILE = "60-claude-dcp-arafays.conf";
const MAC_AGENT = "com.dcp.claude-arafays";
/**
 * Run as `sh -c MAC_SETENV dcp <loader> <token>`: adds the token to launchd's
 * BUN_OPTIONS once, and only while the loader exists.
 */
const MAC_SETENV =
  '[ -f "$1" ] || exit 0; v="$(launchctl getenv BUN_OPTIONS)"; case " $v " in *" $2 "*) ;; *) launchctl setenv BUN_OPTIONS "${v:+$v }$2" ;; esac';

/** Escapes a value for an XML text node. */
function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A launchd agent that runs `args` at each login. */
function launchAgent(label: string, args: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * An environment.d file appending the token to BUN_OPTIONS. environment.d
 * expands `${VAR:+...}` and strips the double quotes; inside them `\`, `"` and
 * `$` are escaped (`$` by doubling).
 */
function environmentD(token: string): string {
  const escaped = token.replace(/[\\"]/g, "\\$&").replace(/\$/g, "$$$$");
  return [
    "# Added by the DCP Claude Code plugin; removed when the plugin is uninstalled.",
    `BUN_OPTIONS="\${BUN_OPTIONS:+$BUN_OPTIONS }${escaped}"`,
    "",
  ].join("\n");
}

/** Joins path parts with the platform separator, dropping the first part's trailing ones. */
function pathJoin(win: boolean, ...parts: string[]): string {
  return parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, "") : part))
    .join(win ? "\\" : "/");
}

/** A PowerShell single-quoted string literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The whitespace-separated entries of an env value such as BUN_OPTIONS. */
function words(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter((w) => w.length > 0);
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: "prune",
      description:
        "Unavailable: DCP's proxy, which performs pruning, is not handling this conversation. Do not call this tool.",
      inputSchema: { type: "object" },
      isDeferred: false,
    });

    let status: string | undefined;
    try {
      const win = (await $.env.get("OS")) === "Windows_NT";
      const home = win ? await $.env.get("USERPROFILE") : await $.env.get("HOME");
      const dataHome =
        (await $.env.get("XDG_DATA_HOME")) ||
        (win
          ? (await $.env.get("LOCALAPPDATA")) || pathJoin(win, home ?? "", "AppData", "Local")
          : pathJoin(win, home ?? "", ".local", "share"));
      const dir = pathJoin(win, dataHome, "claude-dcp-arafays");
      const root = $.plugin.root.replace(/[\\/]+$/, "");
      const source = pathJoin(win, root, "dist", "claude-loader.mjs");
      const loader = pathJoin(win, dir, "claude-loader.mjs");
      const token = `--preload=${loader.replace(/\\/g, "/")}`;
      const dry = (await $.env.get("CLAUDE_DCP_DRY")) === "1";

      if (/\s/.test(dir)) {
        status = `DCP is not active: its loader path contains a space (${dir}), which BUN_OPTIONS cannot carry. Set XDG_DATA_HOME to a path without spaces and restart Claude Code.`;
      } else if (!(await $.fs.exists(source))) {
        status =
          "DCP is not active: this plugin package has no built loader (dist/claude-loader.mjs). Reinstall the plugin from its npm package.";
      } else {
        // Staged means the staged loader matches the packaged one, so an update
        // restages even when it installs to the same plugin dir (an unversioned
        // plugin always does).
        const marker = pathJoin(win, dir, "active.json");
        const staged =
          (await $.fs.exists(loader)) && (await $.fs.read(source)) === (await $.fs.read(loader));

        if (!staged) {
          const copied = await $.process.run(
            win
              ? [
                  "powershell",
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `New-Item -ItemType Directory -Force -Path ${psQuote(dir)} | Out-Null; Copy-Item -Force -LiteralPath ${psQuote(source)} -Destination ${psQuote(loader)}`,
                ]
              : ["sh", "-c", 'mkdir -p "$0" && cp -f "$1" "$2"', dir, source, loader],
          );
          if (copied.exitCode !== 0) throw new Error(copied.stderr.trim() || "copy failed");
          if (!(await $.fs.exists(loader))) throw new Error("claude-loader.mjs was not staged");
          await $.fs.write(
            marker,
            JSON.stringify(
              {
                pluginId: PLUGIN_ID,
                pluginRoot: root,
                loaderPath: loader,
                stagedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
        }

        if (!words(await $.env.get("BUN_OPTIONS")).includes(token)) {
          const profileLine = `export BUN_OPTIONS="\${BUN_OPTIONS:+$BUN_OPTIONS }${token}"`;
          const kernel = win ? "" : (await $.process.run(["uname", "-s"])).stdout.trim();
          if (kernel === "Darwin") {
            // launchd hands its environment to apps started from the Dock, Finder
            // or Spotlight; the agent re-applies it at each login, and only while
            // the staged loader exists.
            const agents = pathJoin(win, home ?? "", "Library", "LaunchAgents");
            const plist = pathJoin(win, agents, `${MAC_AGENT}.plist`);
            const args = ["/bin/sh", "-c", MAC_SETENV, "dcp", loader, token];
            if (dry) {
              status = `DCP DRY: would write ${plist} and add ${token} to launchd's BUN_OPTIONS`;
            } else {
              const made = await $.process.run(["mkdir", "-p", agents]);
              if (made.exitCode !== 0) {
                throw new Error(made.stderr.trim() || "creating LaunchAgents failed");
              }
              await $.fs.write(plist, launchAgent(MAC_AGENT, args));
              const set = await $.process.run(args);
              if (set.exitCode !== 0) throw new Error(set.stderr.trim() || "launchctl setenv failed");
              status = `DCP installed: quit and reopen Claude Code (or the app or terminal that starts it) to activate it. A shell profile that sets BUN_OPTIONS itself needs: ${profileLine}`;
            }
          } else if (!win) {
            // The systemd user instance reads environment.d at login and passes it
            // to the desktop session and the apps it starts.
            const configHome =
              (await $.env.get("XDG_CONFIG_HOME")) || pathJoin(win, home ?? "", ".config");
            const envDir = pathJoin(win, configHome, "environment.d");
            const envFile = pathJoin(win, envDir, LINUX_ENV_FILE);
            if (dry) {
              status = `DCP DRY: would write ${envFile}`;
            } else {
              const made = await $.process.run(["mkdir", "-p", envDir]);
              if (made.exitCode !== 0) {
                throw new Error(made.stderr.trim() || "creating environment.d failed");
              }
              await $.fs.write(envFile, environmentD(token));
              status = `DCP installed: log out and back in, then restart Claude Code, to activate it for apps started from your desktop session. For SSH or console shells, add this to your shell profile: ${profileLine}`;
            }
          } else {
            const read = await $.process.run([
              "powershell",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "[Environment]::GetEnvironmentVariable('BUN_OPTIONS','User')",
            ]);
            const parts = words(read.stdout);
            if (parts.includes(token)) {
              status =
                "DCP is set up but not active in this Claude Code process, which started before it was installed. Restart Claude Code to activate it.";
            } else if (dry) {
              status = `DCP DRY: would set User BUN_OPTIONS to ${[...parts, token].join(" ")}`;
            } else {
              const set = await $.process.run([
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `[Environment]::SetEnvironmentVariable('BUN_OPTIONS', ${psQuote([...parts, token].join(" "))}, 'User')`,
              ]);
              if (set.exitCode !== 0) {
                throw new Error(set.stderr.trim() || "setting BUN_OPTIONS failed");
              }
              status =
                "DCP installed: restart Claude Code (a new terminal, or quit and reopen the app) to activate it. This session is not pruned yet.";
            }
          }
        }
      }
    } catch (error) {
      status = `DCP is not active: staging its loader failed (${error instanceof Error ? error.message : String(error)}).`;
    }
    if (status !== undefined) {
      try {
        await $.ui.status(status);
      } catch {
        // A surface without a status line has nowhere to show it.
      }
    }
    return next(e);
  });

  // A registered tool's result is a string or an array of content blocks.
  on("tool.call", { tool: TOOL }, () => ({ result: RESULT })).catch(() => ({ result: RESULT }));
};
