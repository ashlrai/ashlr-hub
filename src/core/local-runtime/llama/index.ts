/**
 * The supervised llama-server local serving runtime.
 *
 * Read docs/LOCAL-FLEET.md first: Ollama cannot serve Qwen3.8 concurrently
 * (`architecture=qwen35` refuses parallel requests), llama-server can, and
 * that measurement is why this module family exists at all.
 *
 * TWO LANES, and they are not interchangeable:
 *   - OpenAI-compatible completions go straight to llama-server via
 *     {@link resolveLlamaServerBaseUrl}.
 *   - Anthropic (`/v1/messages`) goes through the normalising proxy via
 *     {@link resolveLocalAnthropicBaseUrl}, because Qwen3.8's chat template
 *     rejects Claude Code's request shape outright. See anthropic-shim.ts.
 *
 * Public surface, in the order a caller usually needs it:
 *   - {@link resolveLlamaServerBaseUrl}  which runtime the fleet dispatches to
 *   - {@link resolveLocalAnthropicBaseUrl}  where an Anthropic client points
 *   - {@link startLocalRuntime} / {@link stopLocalRuntime} / {@link restartLocalRuntime}
 *   - {@link statusLocalRuntime} / {@link probeLlamaRuntime}  typed health
 *   - {@link fleetConcurrencyLimit}  the ONLY legitimate source of fleet width
 *   - {@link installLaunchAgent} / {@link uninstallLaunchAgent}  genuine 24/7
 */

export type {
  AnthropicProxyLifecycleResult,
  AnthropicProxyOwnershipRecord,
  LlamaLifecycleResult,
  LlamaLivenessFacts,
  LlamaOwnershipRecord,
  LlamaRuntimeConfig,
  LlamaRuntimeOwner,
  LlamaRuntimeSnapshot,
  LlamaRuntimeState,
  LlamaSlotCapacity,
  ServingRuntimeIdentity,
} from './types.js';

export {
  DEFAULT_ANTHROPIC_PROXY_PORT,
  DEFAULT_LLAMA_CONTEXT,
  DEFAULT_LLAMA_HOST,
  DEFAULT_LLAMA_PORT,
  DEFAULT_LLAMA_SLOTS,
  LEGACY_DEFAULT_BASE_URL,
  allowsNonLoopback,
  baseUrlFromRecord,
  buildLlamaServerArgs,
  gateBindHost,
  isLoopbackHost,
  originFor,
  resolveLlamaRuntimeConfig,
  resolveLlamaServerBaseUrl,
  resolveLlamaServerBin,
  resolveLlamaServerDefaultModel,
  resolveLlamaServerOrigin,
  resolveLocalAnthropicBaseUrl,
} from './config.js';
export type { GatedBindHost } from './config.js';

/**
 * The Anthropic lane. `resolveLocalAnthropicBaseUrl` (above) is what a caller
 * points an Anthropic client at; these start and stop the listener that URL
 * names. The OpenAI-compatible lane keeps using `resolveLlamaServerBaseUrl`
 * and never passes through here.
 */
export {
  ANTHROPIC_MESSAGES_PATH,
  MAX_NORMALISED_BODY_BYTES,
  anthropicProxyHandle,
  ensureAnthropicProxy,
  isMessagesPost,
  normaliseMessagesBody,
  startAnthropicProxy,
  stopAnthropicProxy,
  upstreamTarget,
} from './anthropic-proxy.js';
export type { AnthropicProxyHandle, AnthropicProxyOptions } from './anthropic-proxy.js';

/**
 * The DETACHED Anthropic lane — a child process with its own ownership record,
 * which is what makes `ashlr local-runtime start` leave a working endpoint
 * behind instead of taking the listener with it when the CLI exits. The
 * in-process `ensureAnthropicProxy` above remains for a long-lived host that
 * genuinely wants the listener inside itself.
 */
export {
  DEFAULT_PROXY_START_TIMEOUT_MS,
  anthropicProxyAccepts,
  anthropicProxyResponds,
  ensureDetachedAnthropicProxy,
  statusDetachedAnthropicProxy,
  stopDetachedAnthropicProxy,
  upstreamPortFromArgv,
} from './proxy-supervisor.js';
export type { DetachedProxyOptions } from './proxy-supervisor.js';

export {
  ANTHROPIC_PROXY_COMMAND,
  ANTHROPIC_PROXY_HOST_FLAG,
  ANTHROPIC_PROXY_PORT_FLAG,
  ANTHROPIC_PROXY_UPSTREAM_PORT_FLAG,
  anthropicProxyHostArgs,
  anthropicProxyHostInvocation,
  argvBindsAnthropicPort,
  argvMatchesProxyRecord,
  currentHostInvocationContext,
  findAnthropicProxiesOnPort,
  isAnthropicProxyHostArgv,
} from './proxy-process.js';
export type { DiscoveredAnthropicProxy, HostInvocationContext } from './proxy-process.js';

export {
  clearAnthropicProxyRecord,
  parseAnthropicProxyRecord,
  quarantineAnthropicProxyRecord,
  readAnthropicProxyRecord,
  writeAnthropicProxyRecord,
} from './proxy-record.js';

export { parseProxyHostArgs, runAnthropicProxyHost } from './proxy-host.js';

export { anthropicContentText, normaliseAnthropicRequest } from './anthropic-shim.js';
export type { AnthropicTextBlock } from './anthropic-shim.js';

export {
  OLLAMA_PARALLEL_REFUSAL,
  composeSnapshot,
  deriveSlotCapacity,
  fleetConcurrencyLimit,
  identifyRuntime,
  interpretHealth,
  probeLlamaRuntime,
} from './health.js';
export type { EndpointReading, FetchLike, LlamaProbeReadings, ProbeOptions } from './health.js';

export {
  DEFAULT_START_TIMEOUT_MS,
  isPortFree,
  restartLocalRuntime,
  startLocalRuntime,
  statusLocalRuntime,
  stopLocalRuntime,
} from './supervisor.js';
export type { LifecycleOptions } from './supervisor.js';

export {
  buildLaunchAgentPlist,
  buildLaunchAgentShim,
  installLaunchAgent,
  launchAgentInstalled,
  launchAgentLoaded,
  launchAgentLogPaths,
  shQuote,
  uninstallLaunchAgent,
} from './launchd.js';
export type { LaunchAgentMutation, LaunchAgentSpec } from './launchd.js';

export {
  blobBasenameForDigest,
  parseOllamaModelRef,
  resolveOllamaModelBlob,
  resolveOllamaRefForBlobPath,
  selectModelLayer,
} from './ollama-blob.js';
export type { OllamaBlobResolution, OllamaModelRef, ResolvedOllamaBlob } from './ollama-blob.js';

export {
  argvBindsPort,
  argvMatchesRecord,
  findLlamaServersOnPort,
  modelPathFromArgv,
  processAlive,
  processTable,
  shouldReclaim,
} from './process.js';
export type { ProcessTableEntry } from './process.js';

export {
  clearOwnershipRecord,
  parseOwnershipRecord,
  readOwnershipRecord,
  writeOwnershipRecord,
} from './record.js';

export {
  LAUNCH_AGENT_LABEL,
  anthropicProxyRecordPath,
  anthropicProxyStderrLogPath,
  anthropicProxyStdoutLogPath,
  launchAgentPlistPath,
  launchAgentShimPath,
  localRuntimeDir,
  logsDir,
  ollamaModelsRoot,
  ownershipRecordPath,
  stderrLogPath,
  stdoutLogPath,
} from './paths.js';
