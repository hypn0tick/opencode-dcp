/**
 * Public surface of the Claude Code adapter: the pieces a deployment layer (the
 * preloaded loader in `boot.ts`, or a standalone proxy) composes to run
 * opencode-dcp's context pipeline against Claude Code's model requests. The
 * pipeline itself and the prune tool are reused unchanged from the package's
 * `lib/`; this adapter only converts the wire format and wires the host
 * contract.
 */

export {
  ClaudeAdapter,
  modelWindow,
  type AdapterOptions,
  type RequestContext,
  type Usage,
} from "./host";
export { configFromEnv, start, stop } from "./loader";
export {
  contextFromHeaders,
  installFetchInterception,
  shouldHandle,
  transformBody,
  type HeaderLookup,
  type RequestObserver,
} from "./proxy";
export {
  fromWire,
  rebuildSystem,
  toWire,
  type AnthropicBlock,
  type AnthropicMessage,
  type AnthropicRequest,
  type WireMeta,
} from "./wire";
