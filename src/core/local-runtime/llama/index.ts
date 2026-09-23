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
  shouldReclaim,
} from './process.js';

export {
  clearOwnershipRecord,
  parseOwnershipRecord,
  readOwnershipRecord,
  writeOwnershipRecord,
} from './record.js';

export {
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  launchAgentShimPath,
  localRuntimeDir,
  logsDir,
  ollamaModelsRoot,
  ownershipRecordPath,
  stderrLogPath,
  stdoutLogPath,
} from './paths.js';

/**
 * The Anthropic proxy as a supervised PROCESS.
 *
 * `ensureAnthropicProxy` (above) hosts the listener inside the calling
 * process, which is right for an attended `start` and useless for a lane that
 * has to be up at 3am. These are the pieces that give it a launchd job of its
 * own: the invocation resolver (which reads the MODULE's location, never
 * `process.argv[1]` — see proxy-invocation.ts for the defect that rule exists
 * to prevent) and the agent install/uninstall.
 */
export {
  ANTHROPIC_PROXY_HOST_FLAG,
  anthropicProxyHostArgv,
  anthropicProxyHostEnvironment,
  anthropicProxyHostInvocation,
} from './proxy-invocation.js';
export type { AnthropicProxyHostOptions } from './proxy-invocation.js';
export {
  anthropicProxyAgentInstalled,
  anthropicProxyAgentLoaded,
  anthropicProxyLogPaths,
  buildAnthropicProxyPlist,
  buildAnthropicProxyShim,
  installAnthropicProxyAgent,
  uninstallAnthropicProxyAgent,
} from './proxy-launchd.js';
export type { AnthropicProxyAgentSpec } from './proxy-launchd.js';
export {
  ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL,
  anthropicProxyPlistPath,
  anthropicProxyShimPath,
} from './paths.js';
