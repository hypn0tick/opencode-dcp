/**
 * The proxy runtime: the seam where the loader Claude Code's embedded Bun
 * preloads intercepts the model requests and runs them through `ClaudeAdapter`.
 *
 * Claude Code's standalone binary issues model requests through
 * `Bun.FetchSession` (and `globalThis.fetch` elsewhere), with the per-request
 * metadata the adapter needs carried in headers rather than the body. The
 * interception reads those headers and transforms the `/v1/messages` body. It
 * transforms the `/v1/messages/count_tokens` body the same way, so Claude Code
 * sizes its context (and times auto-compaction) from the pruned transcript. A
 * request the adapter fails on goes out unmodified.
 *
 * Responses pass through byte for byte, with two exceptions on a main
 * `/v1/messages` stream. When the request offered the no-op `prune` mod's tool,
 * the `tool_use` the model emits under the bare `prune` name is renamed to the
 * mod's `mcp__dcp__prune`, so the engine routes a clean success to the mod
 * instead of a no-such-tool error. And the usage the stream reports is read
 * (never rewritten, since Claude Code counts its window from it) and fed to the
 * adapter, which sizes the next request's nudges from it.
 *
 * `contextFromHeaders`, `shouldHandle`, `transformBody`, `renameToolUseLine`,
 * `readUsageLine` and `createSseTap` are pure and tested;
 * `installFetchInterception` is the thin runtime wiring validated in a live
 * binary, since no unit test can stand in for Bun's fetch internals.
 */

import type { ClaudeAdapter, RequestContext, Usage } from "./host";
import { responseRename } from "./prune-router";
import type { AnthropicRequest } from "./wire";

const SESSION_ID = "x-claude-code-session-id";
const REQUEST_CLASS = "x-claude-code-request-class";
const ANTHROPIC_BETA = "anthropic-beta";
const CONTEXT_1M_WINDOW = 1_000_000;

/** A minimal header view; `Headers` satisfies it. */
export interface HeaderLookup {
  get(name: string): string | null;
}

/** Derives the per-request context Claude Code carries in request headers. */
export function contextFromHeaders(headers: HeaderLookup): RequestContext {
  const beta = headers.get(ANTHROPIC_BETA) ?? "";
  return {
    sessionId: headers.get(SESSION_ID) ?? "",
    requestClass: headers.get(REQUEST_CLASS) ?? undefined,
    window: /(?:^|,)\s*context-1m/.test(beta) ? CONTEXT_1M_WINDOW : undefined,
  };
}

/** The request paths the proxy transforms: the message send and its token count. */
export function shouldHandle(url: string): boolean {
  const path = pathOf(url);
  return path.endsWith("/v1/messages") || path.endsWith("/v1/messages/count_tokens");
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const q = url.indexOf("?");
    return q === -1 ? url : url.slice(0, q);
  }
}

/** A transformed request body, and the response rename it calls for. */
export interface Transformed {
  body: string;
  /** Set when the request offered the mod's tool and was transformed. */
  rename?: { from: string; to: string };
}

/**
 * Transforms a request body string through the adapter. Returns the input
 * unchanged when it cannot be keyed to a session, does not parse, or carries no
 * messages, and when the adapter throws, so a DCP fault never fails a request.
 */
export async function transformBody(
  body: string,
  ctx: RequestContext,
  adapter: ClaudeAdapter,
): Promise<Transformed> {
  if (ctx.sessionId.length === 0) return { body };
  let request: AnthropicRequest;
  try {
    request = JSON.parse(body) as AnthropicRequest;
  } catch {
    return { body };
  }
  if (!Array.isArray(request.messages)) return { body };
  let next: AnthropicRequest;
  try {
    next = await adapter.apply(request, ctx);
  } catch (error) {
    adapter.reportError(error);
    return { body };
  }
  if (next === request) return { body };
  return { body: JSON.stringify(next), rename: responseRename(request.tools) };
}

/**
 * Renames a `tool_use` block's `name` in one Anthropic SSE line. Only a
 * `content_block_start` whose block is a `tool_use` named `from` is touched;
 * every other line passes through byte-for-byte. Anthropic sends one compact
 * JSON object per `data:` line, so re-serializing the matched line reproduces
 * the original framing.
 */
export function renameToolUseLine(line: string, from: string, to: string): string {
  const match = /^(data:\s*)(\{.*\})\s*$/.exec(line);
  if (match === null) return line;
  let event: { type?: unknown; content_block?: { type?: unknown; name?: unknown } };
  try {
    event = JSON.parse(match[2]!) as typeof event;
  } catch {
    return line;
  }
  const block = event.content_block;
  if (
    event.type === "content_block_start" &&
    block &&
    block.type === "tool_use" &&
    block.name === from
  ) {
    block.name = to;
    return match[1]! + JSON.stringify(event);
  }
  return line;
}

interface UsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Folds the usage a `message_start` or `message_delta` SSE line reports into
 * `usage`, returning whether the line carried any. `message_start` holds the
 * input side; `message_delta` holds the running output count.
 */
export function readUsageLine(line: string, usage: Usage): boolean {
  if (!line.startsWith("data:") || !line.includes('"usage"')) return false;
  let event: { type?: unknown; message?: { usage?: UsageFields }; usage?: UsageFields };
  try {
    event = JSON.parse(line.slice(5)) as typeof event;
  } catch {
    return false;
  }
  const fields = event.type === "message_start" ? event.message?.usage : event.usage;
  if (fields === undefined || (event.type !== "message_start" && event.type !== "message_delta")) {
    return false;
  }
  if (typeof fields.input_tokens === "number") usage.input = fields.input_tokens;
  if (typeof fields.cache_read_input_tokens === "number") {
    usage.cacheRead = fields.cache_read_input_tokens;
  }
  if (typeof fields.cache_creation_input_tokens === "number") {
    usage.cacheWrite = fields.cache_creation_input_tokens;
  }
  if (typeof fields.output_tokens === "number") usage.output = fields.output_tokens;
  return true;
}

/** What a response stream's tap does: rename a tool_use, and report usage. */
export interface ResponseTap {
  rename?: { from: string; to: string };
  onUsage?: (usage: Usage) => void;
}

/**
 * A line-buffering SSE transformer: renames a tool_use name across chunk
 * boundaries and reports the stream's usage once it ends. `transform` emits the
 * lines completed so far; `flush` emits any trailing partial line.
 */
export function createSseTap(tap: ResponseTap): {
  transform(chunk: string): string;
  flush(): string;
} {
  let buffer = "";
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  let reported = false;
  const report = (): void => {
    if (!sawUsage || reported) return;
    reported = true;
    tap.onUsage?.(usage);
  };
  const line = (text: string): string => {
    if (tap.onUsage) {
      if (readUsageLine(text, usage)) sawUsage = true;
      // A consumer may stop reading at message_stop, before the stream ends.
      else if (text.startsWith("data:") && text.includes('"message_stop"')) report();
    }
    return tap.rename ? renameToolUseLine(text, tap.rename.from, tap.rename.to) : text;
  };
  return {
    transform(chunk: string): string {
      buffer += chunk;
      let out = "";
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        out += line(buffer.slice(0, nl)) + "\n";
        buffer = buffer.slice(nl + 1);
      }
      return out;
    },
    flush(): string {
      const rest = buffer;
      buffer = "";
      const out = rest === "" ? "" : line(rest);
      report();
      return out;
    },
  };
}

/**
 * Runs a streaming SSE response through the tap, leaving status, headers and
 * every untouched byte intact. A non-streaming or bodiless response passes
 * through unchanged.
 */
function tapResponseStream(response: Response, tap: ResponseTap): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.body === null || !contentType.includes("text/event-stream")) return response;
  const sse = createSseTap(tap);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const out = sse.transform(decoder.decode(chunk, { stream: true }));
      if (out !== "") controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      const out = sse.transform(decoder.decode()) + sse.flush();
      if (out !== "") controller.enqueue(encoder.encode(out));
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length"); // the rewritten stream's length is not preserved
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Observes each handled request after transformation (logging, metrics). */
export interface RequestObserver {
  (record: { url: string; ctx: RequestContext; before: string; after: string }): void;
}

/** The subset of `Bun.FetchSession` the interception extends. */
interface BunFetchSession {
  fetch(input: unknown, init?: RequestInit): Promise<Response>;
}

/**
 * Wires the interception into the running binary: every model request through
 * `Bun.FetchSession` or `globalThis.fetch` has its handled bodies transformed,
 * and each main message response is tapped for the rename and its usage. An
 * optional observer sees each handled request after transformation. Returns a
 * function that restores the originals. Not unit-tested, since it depends on
 * Bun's fetch internals.
 */
export function installFetchInterception(
  adapter: ClaudeAdapter,
  observe?: RequestObserver,
): () => void {
  const urlOf = (input: unknown): string =>
    input instanceof Request ? input.url : String(input);

  const edit = async (
    url: string,
    init: RequestInit | undefined,
  ): Promise<{ init: RequestInit | undefined; tap?: ResponseTap }> => {
    if (!init || typeof init.body !== "string" || !shouldHandle(url)) return { init };
    try {
      const ctx = contextFromHeaders(new Headers(init.headers));
      const before = init.body;
      const { body: after, rename } = await transformBody(before, ctx, adapter);
      observe?.({ url, ctx, before, after });
      const message = pathOf(url).endsWith("/v1/messages");
      // Only main responses size the next request; a sub-agent shares the session id.
      const main = adapter.enabled && (ctx.requestClass ?? "main") === "main";
      const tap: ResponseTap = {
        rename: message ? rename : undefined,
        onUsage:
          message && main && ctx.sessionId
            ? (usage) => adapter.recordUsage(ctx.sessionId, usage)
            : undefined,
      };
      return { init: after === before ? init : { ...init, body: after }, tap };
    } catch (error) {
      adapter.reportError(error);
      return { init };
    }
  };

  const respond = (response: Response, tap: ResponseTap | undefined): Response =>
    tap && (tap.rename || tap.onUsage) ? tapResponseStream(response, tap) : response;

  const restorers: Array<() => void> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input: string | URL | Request, init?: RequestInit) {
    const { init: edited, tap } = await edit(urlOf(input), init);
    return respond(await originalFetch(input, edited), tap);
  };
  restorers.push(() => {
    globalThis.fetch = originalFetch;
  });

  const FS = (
    globalThis as { Bun?: { FetchSession?: new (...args: unknown[]) => BunFetchSession } }
  ).Bun?.FetchSession;
  if (FS) {
    const bun = (globalThis as unknown as { Bun: { FetchSession: typeof FS } }).Bun;
    bun.FetchSession = class extends FS {
      override async fetch(input: unknown, init?: RequestInit): Promise<Response> {
        const { init: edited, tap } = await edit(urlOf(input), init);
        return respond(await super.fetch(input, edited), tap);
      }
    };
    restorers.push(() => {
      bun.FetchSession = FS;
    });
  }

  return () => {
    for (const restore of restorers.reverse()) restore();
  };
}
