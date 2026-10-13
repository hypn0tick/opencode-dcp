/**
 * Host shim: runs opencode-dcp's `context` pipeline over a Claude Messages API
 * request, with no OpenCode server behind it. It converts the request to the
 * transcript shape `createContextHook` expects (`lib/transform.ts`), invokes
 * the pipeline, and converts the edited transcript back into a request body.
 *
 * The pipeline's host contract is small: a config, a logger, the per-session
 * `StateStore`/`TranscriptMirror`/`UsageTracker`, a sub-agent predicate, and a
 * model-context-window lookup. Everything the OpenCode plugin wired through
 * `ctx.session`/`ctx.event` is either unused by the context hook (those drive
 * the prune tool and event pump, handled elsewhere in the adapter) or supplied
 * here from the request itself.
 */

import { resolveOptions, type DcpOptions } from "../config";
import { createLogger, type Logger } from "../logger";
import { UsageTracker, type UsageInfo } from "../nudges";
import { pruneToolDefinition } from "../prune-tool";
import { activeBlocks, StateStore, type JsonStorage } from "../state/store";
import { createContextHook, type SessionContextEvent } from "../transform";
import { TranscriptMirror } from "../transcript/mirror";
import { scanTranscript } from "../transcript/scan";
import {
  findPruneCalls,
  offeredPruneName,
  pruneWireDef,
  rewriteOfferedPruneDef,
  rewritePruneResult,
} from "./prune-router";
import { fromWire, rebuildSystem, toWire, type AnthropicRequest } from "./wire";
import type { WireMessage } from "../types";

export interface AdapterOptions {
  /** Raw DCP options, resolved through the plugin's own `resolveOptions`. */
  dcp?: Record<string, unknown>;
  /** Persisted per-session state; omit for in-memory (per-process) state. */
  storage?: JsonStorage;
}

/** Per-request facts the wire body does not carry; the stub reads them from headers. */
export interface RequestContext {
  /** `x-claude-code-session-id`. State is keyed by it. */
  sessionId: string;
  /** Request class: `main`, `subagent`, `compaction`, `auxiliary`. */
  requestClass?: string;
  /** Model context window in tokens, when the stub resolved one (e.g. 1M beta). */
  window?: number;
}

/** A main response's usage, as the API reports it in its stream. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Request classes whose transcripts the pipeline must leave untouched. */
const SKIP_CLASSES = new Set(["compaction", "auxiliary"]);

const CLAUDE_DEFAULT_WINDOW = 200_000;

/** Best-effort model context window; the stub's explicit `window` wins. */
export function modelWindow(modelId: string, override?: number): number | undefined {
  if (typeof override === "number" && override > 0) return override;
  if (/claude|haiku|sonnet|opus/i.test(modelId)) return CLAUDE_DEFAULT_WINDOW;
  return undefined;
}

export class ClaudeAdapter {
  private readonly config: DcpOptions;
  private readonly logger: Logger;
  private readonly store: StateStore;
  private readonly mirror = new TranscriptMirror();
  private readonly usage = new UsageTracker();
  private readonly handle: (event: SessionContextEvent) => Promise<void>;
  private readonly prune: ReturnType<typeof pruneToolDefinition>;
  /** Per-session prune memory: ids executed once, and each call's ack text. */
  private readonly pruneState = new Map<string, { done: Set<string>; ack: Map<string, string> }>();
  private window: number | undefined;
  /** Session-cumulative usage of main responses, the form `UsageTracker` reads. */
  private readonly usageTotals = new Map<string, UsageInfo>();

  constructor(options: AdapterOptions = {}) {
    const warn = createLogger(false);
    this.config = resolveOptions(options.dcp, (message) => warn.warn(`config warning: ${message}`));
    this.logger = createLogger(this.config.debug);
    this.store = new StateStore(options.storage);
    this.handle = createContextHook({
      config: this.config,
      logger: this.logger,
      store: this.store,
      mirror: this.mirror,
      usage: this.usage,
      // Sub-agent sessions are gated in `apply` before conversion, so the
      // pipeline never needs to ask again.
      isSubAgent: async () => false,
      catalogContextLimit: async () => this.window,
    });
    this.prune = pruneToolDefinition({
      store: this.store,
      mirror: this.mirror,
      logger: this.logger,
      config: this.config,
      getModelContextLimit: () => this.window,
      getUsageTokens: (sessionId) => this.usage.totalFor(sessionId),
      markPruned: (sessionId) => this.usage.markPruned(sessionId),
    });
  }

  /**
   * Applies the pipeline to a request, returning a new body to send onward.
   * Returns the request unchanged when DCP is disabled, the request class is
   * one the pipeline must not touch, or the session is a sub-agent and
   * `allowSubAgents` is off.
   */
  async apply(request: AnthropicRequest, ctx: RequestContext): Promise<AnthropicRequest> {
    if (!this.config.enabled) return request;
    if (ctx.requestClass && SKIP_CLASSES.has(ctx.requestClass)) return request;
    if (ctx.requestClass === "subagent" && !this.config.allowSubAgents) return request;

    const { system, messages, meta } = toWire(request);
    const model = typeof request.model === "string" ? request.model : "";
    this.window = modelWindow(model, ctx.window);

    // Execute any prune the model called, before the context hook re-scans:
    // the call's boundary ids resolve against the dispatch the model saw,
    // which is still the transcript held in the mirror.
    await this.routePrune(messages, ctx.sessionId);

    // Offer opencode-dcp's `prune` under its own name so the model follows the
    // plugin's unmodified guidance. When a mod already registered a namespaced
    // `*__prune`, rewrite that offered entry to the canonical bare definition
    // (the response side restores the mod's name to route the call back to it);
    // otherwise inject the definition. Either way the model sees `prune`, and
    // `canPrune` finds it in `tools`.
    const offered = offeredPruneName(request.tools);
    const tools =
      offered !== undefined
        ? rewriteOfferedPruneDef(request.tools, this.prune.description, this.prune.input)
        : [
            ...(Array.isArray(request.tools) ? request.tools : []),
            pruneWireDef(this.prune.description, this.prune.input),
          ];

    const event: SessionContextEvent = {
      sessionID: ctx.sessionId,
      agent: ctx.requestClass === "subagent" ? "subagent" : "claude",
      model: { providerID: "anthropic", id: model },
      tools: toolMap(tools),
      system,
      messages,
    };

    await this.handle(event);
    await this.store.persist(ctx.sessionId);

    const { messages: rebuilt } = fromWire(event.messages, meta);
    const nextSystem = rebuildSystem(event.system, meta);
    const next: AnthropicRequest = { ...request, messages: rebuilt };
    next.tools = tools;
    if (nextSystem === undefined) delete next.system;
    else next.system = nextSystem;
    return next;
  }

  /** Whether DCP is enabled (`CLAUDE_DCP_ENABLED` and the resolved options). */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Feeds one main response's usage, as the API reported it, to the context
   * tracker the nudges read. The tracker works on session-cumulative totals
   * (OpenCode's usage events), so this keeps a running total, starting from a
   * zero baseline so the first response already counts.
   */
  recordUsage(sessionId: string, usage: Usage): void {
    let total = this.usageTotals.get(sessionId);
    if (total === undefined) {
      total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      this.usage.record(sessionId, { ...total });
    }
    total = {
      input: total.input + usage.input,
      output: total.output + usage.output,
      reasoning: 0,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
    };
    this.usageTotals.set(sessionId, total);
    this.usage.record(sessionId, { ...total });
  }

  /** Logs a request the proxy sent unmodified because `apply` threw. */
  reportError(error: unknown): void {
    this.logger.warn("Claude adapter failed; request sent unmodified", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Runs opencode-dcp's prune for each `prune` call in the transcript, once per
   * tool-use id, and rewrites each call's result to the ack so the model reads
   * success rather than the engine's no-such-tool error. A failed execute (a
   * stale range after a restart) is swallowed into the ack, never retried.
   */
  private async routePrune(messages: WireMessage[], sessionId: string): Promise<void> {
    const calls = findPruneCalls(messages);
    if (calls.length === 0) return;
    // A fresh process (a restart or resume) has no mirror for the session yet,
    // so each call in history replays against a rebuilt view of what the model
    // saw when it issued it.
    const replay = this.mirror.get(sessionId) === undefined;
    let mem = this.pruneState.get(sessionId);
    if (!mem) {
      mem = { done: new Set(), ack: new Map() };
      this.pruneState.set(sessionId, mem);
    }
    for (const call of calls) {
      if (!mem.done.has(call.id)) {
        mem.done.add(call.id);
        if (replay) await this.restoreView(messages.slice(0, call.index), sessionId);
        try {
          const result = (await this.prune.execute(call.input, { sessionID: sessionId })) as {
            content?: unknown;
          };
          mem.ack.set(call.id, typeof result.content === "string" ? result.content : "Pruned.");
        } catch (error) {
          mem.ack.set(
            call.id,
            `Prune not applied: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const ack = mem.ack.get(call.id);
      if (ack !== undefined) rewritePruneResult(messages, call.id, ack);
    }
  }

  /**
   * Rebuilds the dispatch view a prune call's boundary ids resolve against: the
   * mirror and ref table over the transcript before the call, with the blocks of
   * earlier calls already applied. The context hook builds both, but only after
   * routing, so without this a replayed call finds no conversation context.
   */
  private async restoreView(prefix: WireMessage[], sessionId: string): Promise<void> {
    const runtime = await this.store.ensure(sessionId);
    const index = scanTranscript(prefix);
    this.mirror.update(sessionId, index);
    const covered = new Set(activeBlocks(runtime.state).flatMap((block) => block.coveredKeys));
    runtime.refs.project(index.keys.filter((key) => !covered.has(key)));
  }
}

/** The request's tool list keyed by name, so `canPrune` sees what is available. */
function toolMap(
  tools: unknown,
): Record<string, { description?: string; input?: unknown }> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const map: Record<string, { description?: string; input?: unknown }> = {};
  for (const tool of tools) {
    if (tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string") {
      const t = tool as { name: string; description?: string; input_schema?: unknown };
      map[t.name] = { description: t.description, input: t.input_schema };
    }
  }
  return map;
}
